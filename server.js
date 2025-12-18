const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 10000,
  pingInterval: 5000
});

// Filas separadas
let queues = {
  ranked: [],
  friendly: []
};

// Armazena partidas ativas
// Chave: RoomID, Valor: Objeto da partida
const activeMatches = {};

// Middleware de Autenticação/Identificação
io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  socket.user = {
    id: auth.userId || uuidv4(),
    name: auth.name || 'Guerreiro',
    skins: auth.skins || {},
    elo: 1200
  };
  next();
});

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.user.name} (${socket.id})`);

  // ===========================================================================
  // 1. LÓGICA DE RECONEXÃO (REJOIN) - PREVINE O LOOP SE A SALA JÁ ACABOU
  // ===========================================================================
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    // Verifica se o usuário faz parte desta sala E se a sala ainda é válida
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    const match = activeMatches[existingRoomId];

    // [IMPORTANTE] Atualiza o Socket ID na memória da partida
    if (match.p1.id === socket.user.id) match.p1.socketId = socket.id;
    else match.p2.socketId = socket.id;

    socket.join(existingRoomId);
    socket.roomId = existingRoomId;

    // Cancela timer de destruição da sala (alguém voltou)
    if (match.disconnectTimeout) {
      console.log(`[REJOIN] ${socket.user.name} voltou em tempo! Cancelando W.O.`);
      clearTimeout(match.disconnectTimeout);
      delete match.disconnectTimeout;
    }

    const isP1 = (match.p1.id === socket.user.id);

    // --- CHOQUE DE REALIDADE ---

    // Verifica se o OPONENTE está online
    const opponentSocketId = isP1 ? match.p2.socketId : match.p1.socketId;
    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    const isOpponentOnline = opponentSocket && opponentSocket.connected;

    // Prepara dados de sincronia
    const isP1Turn = (match.moveHistory.length % 2 === 0);
    const syncData = {
      history: match.moveHistory,
      serverTurnIsP1: isP1Turn,
      p1Time: match.p1Time || (17 * 60),
      p2Time: match.p2Time || (17 * 60)
    };

    if (isOpponentOnline) {
      console.log(`[REJOIN] ${socket.user.name} voltou. Enviando CHOQUE DE SYNC.`);
      socket.to(existingRoomId).emit('opponent_rejoined_with_state', syncData);
      socket.to(existingRoomId).emit('status', `${socket.user.name} reconectou!`);
    } else {
      console.log(`[REJOIN] ${socket.user.name} voltou, mas oponente OFF. Timer 50s.`);
      socket.emit('status', 'Aguardando oponente retornar (50s)...');
      socket.emit('opponent_disconnected', { timeout: 50 });

      match.disconnectTimeout = setTimeout(() => {
        if (activeMatches[existingRoomId]) {
          console.log(`[TIMEOUT] W.O. na sala ${existingRoomId}`);
          io.to(existingRoomId).emit('game_message', {
            type: 'game_over',
            reason: 'opponent_disconnected',
            result: 'win_by_wo'
          });
          delete activeMatches[existingRoomId]; // Destrói a sala para evitar loop
        }
      }, 50000);
    }

    // Envia o estado atual para quem acabou de voltar
    socket.emit('rejoin_success', {
      isPlayer1: isP1,
      opponent: isP1 ? match.p2 : match.p1,
      history: match.moveHistory,
      mode: match.mode,
      serverTurnIsP1: isP1Turn,
      p1Time: match.p1Time || (17 * 60),
      p2Time: match.p2Time || (17 * 60)
    });
    return; // Encerra aqui para não processar matchmaking
  }

  // ===========================================================================
  // 2. MATCHMAKING
  // ===========================================================================
  socket.on('find_match', (incomingData) => {
    // 1. Limpeza
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    // 2. Leitura do Modo
    let requestedMode = 'ranked';
    try {
      if (typeof incomingData === 'object' && incomingData !== null && incomingData.mode) {
        requestedMode = incomingData.mode;
      } else if (typeof incomingData === 'string') {
        const cleanStr = incomingData.trim();
        if (cleanStr.startsWith('{')) {
          const parsed = JSON.parse(cleanStr);
          if (parsed.mode) requestedMode = parsed.mode;
        } else {
          requestedMode = cleanStr;
        }
      }
    } catch (e) {
      console.log("Erro leitura modo, default: ranked.");
    }

    const finalMode = requestedMode.toLowerCase().trim();
    const modeToUse = (finalMode === 'friendly') ? 'friendly' : 'ranked';

    console.log(`[SEARCH] ${socket.user.name} entrou na fila: ${modeToUse.toUpperCase()}`);

    const currentQueue = queues[modeToUse];

    // Loop para encontrar oponente válido
    let opponent = null;
    while (currentQueue.length > 0) {
      const candidate = currentQueue.shift();
      if (candidate.user.id === socket.user.id) continue;
      if (!candidate.connected) continue;
      opponent = candidate;
      break;
    }

    if (opponent) {
      startMatch(opponent, socket, modeToUse);
    } else {
      currentQueue.push(socket);
      const label = modeToUse === 'friendly' ? 'Amistoso' : 'Ranqueada';
      socket.emit('status', `Buscando ${label}...`);
    }
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
    console.log(`[LEAVE] ${socket.user.name} saiu da fila.`);
  });

  // ===========================================================================
  // 3. GAMEPLAY (AQUI ESTÁ A CORREÇÃO DO LOOP ETERNO)
  // ===========================================================================
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const match = activeMatches[rId];

      match.moveHistory.push(msg);

      // Atualiza tempos
      if (msg.p1Time !== undefined) match.p1Time = msg.p1Time;
      if (msg.p2Time !== undefined) match.p2Time = msg.p2Time;

      // Repassa a mensagem para o oponente
      socket.to(rId).emit('game_message', msg);

      // --- CORREÇÃO DO LOOP: DETECÇÃO DE FIM DE JOGO ---

      // Caso 1: A mensagem diz explicitamente que é game over
      if (msg.type === 'game_over' || msg.gameOver === true) {
        console.log(`[GAME OVER] Detectado via game_move na sala ${rId}. Deletando sala.`);
        if (match.disconnectTimeout) clearTimeout(match.disconnectTimeout);
        delete activeMatches[rId]; // <--- TIRA O JOGADOR DO LOOP
        return;
      }

      // Caso 2: O tempo acabou (AFK) detectado pelo servidor
      if ((match.p1Time !== undefined && match.p1Time <= 0) ||
        (match.p2Time !== undefined && match.p2Time <= 0)) {
        console.log(`[GAME OVER] Tempo esgotado (AFK) na sala ${rId}. Deletando sala.`);

        // Avisa ambos que acabou por tempo (garantia)
        io.to(rId).emit('game_message', {
          type: 'game_over',
          reason: 'time_out'
        });

        if (match.disconnectTimeout) clearTimeout(match.disconnectTimeout);
        delete activeMatches[rId]; // <--- TIRA O JOGADOR DO LOOP
      }
    }
  });

  // Listener explícito para Game Over (Relatado pelo cliente)
  socket.on('game_over_report', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      console.log(`[GAME OVER REPORT] Cliente reportou fim na sala ${rId}. Fechando.`);

      // Avisa o oponente que acabou (caso ele não saiba)
      socket.to(rId).emit('game_message', {
        type: 'game_over',
        report_data: data
      });

      if (activeMatches[rId].disconnectTimeout) clearTimeout(activeMatches[rId].disconnectTimeout);
      delete activeMatches[rId]; // <--- TIRA O JOGADOR DO LOOP
    }
  });

  // ===========================================================================
  // 4. DESCONEXÃO E TIMER DE 50s
  // ===========================================================================
  socket.on('disconnect', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
      const match = activeMatches[rId];

      console.log(`[DISCONNECT] Jogador caiu na sala ${rId}. Timer de 50s.`);

      socket.to(rId).emit('status', 'Oponente desconectou. Aguardando 50s...');
      socket.to(rId).emit('opponent_disconnected', { timeout: 50 });

      if (!match.disconnectTimeout) {
        match.disconnectTimeout = setTimeout(() => {
          if (activeMatches[rId]) {
            console.log(`[TIMEOUT] W.O. definitivo na sala ${rId}.`);
            io.to(rId).emit('game_message', {
              type: 'game_over',
              reason: 'opponent_disconnected',
              result: 'win_by_wo'
            });
            delete activeMatches[rId]; // Limpa a sala
          }
        }, 50000);
      }
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();

  p1.join(roomId);
  p2.join(roomId);
  p1.roomId = roomId;
  p2.roomId = roomId;

  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, socketId: p1.id, elo: p1.user.elo, skins: p1.user.skins },
    p2: { id: p2.user.id, name: p2.user.name, socketId: p2.id, elo: p2.user.elo, skins: p2.user.skins },
    startTime: Date.now(),
    mode: mode,
    moveHistory: [],
    p1Time: 17 * 60,
    p2Time: 17 * 60
  };

  p1.emit('match_found', {
    isPlayer1: true,
    opponent: { name: p2.user.name, skins: p2.user.skins, elo: p2.user.elo },
    mode: mode
  });

  p2.emit('match_found', {
    isPlayer1: false,
    opponent: { name: p1.user.name, skins: p1.user.skins, elo: p1.user.elo },
    mode: mode
  });

  console.log(`[START] Sala ${roomId} criada.`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
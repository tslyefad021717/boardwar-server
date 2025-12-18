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
const activeMatches = {};

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
  // 1. LÓGICA DE RECONEXÃO (REJOIN) COM CORREÇÃO DE LOOP
  // ===========================================================================
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    const match = activeMatches[existingRoomId];
    socket.join(existingRoomId);
    socket.roomId = existingRoomId;

    const isP1 = (match.p1.id === socket.user.id);

    // Atualiza o socket ID mais recente
    if (isP1) match.p1.socketId = socket.id;
    else match.p2.socketId = socket.id;

    // --- CORREÇÃO DO LOOP INFINITO AQUI ---

    // 1. Se havia um timer rodando contra MIM, eu cancelei porque voltei.
    if (match.disconnectTimeout) {
      clearTimeout(match.disconnectTimeout);
      delete match.disconnectTimeout;
    }

    // 2. AGORA VERIFICAMOS O OPONENTE
    // Se o oponente também estiver fora (fechou o app), precisamos ligar o timer contra ELE.
    const opponentSocketId = isP1 ? match.p2.socketId : match.p1.socketId;
    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    const isOpponentOnline = opponentSocket && opponentSocket.connected;

    if (isOpponentOnline) {
      // Cenário: Ambos estão online. Segue o jogo!
      console.log(`[REJOIN] ${socket.user.name} voltou. Ambos online.`);
      socket.to(existingRoomId).emit('status', `${socket.user.name} reconectou!`);
      socket.to(existingRoomId).emit('opponent_reconnected');
    } else {
      // Cenário: Eu voltei, mas o oponente sumiu.
      // O jogo não pode ficar parado. Iniciamos a contagem para o oponente perder.
      console.log(`[REJOIN] ${socket.user.name} voltou, mas oponente está OFF. Timer de 50s iniciado.`);

      socket.emit('status', 'Aguardando oponente retornar (50s)...');
      socket.emit('opponent_disconnected', { timeout: 50 }); // Avisa meu app para mostrar snackbar

      match.disconnectTimeout = setTimeout(() => {
        if (activeMatches[existingRoomId]) {
          console.log(`[TIMEOUT] Tempo esgotado para oponente na sala ${existingRoomId}. W.O.`);
          io.to(existingRoomId).emit('game_message', {
            type: 'game_over',
            reason: 'opponent_disconnected',
            result: 'win_by_wo'
          });
          delete activeMatches[existingRoomId];
        }
      }, 50000); // 50 segundos
    }

    // Calcular turno para sincronia (Evita que os dois fiquem esperando)
    const isP1Turn = (match.moveHistory.length % 2 === 0);

    socket.emit('rejoin_success', {
      isPlayer1: isP1,
      opponent: isP1 ? match.p2 : match.p1,
      history: match.moveHistory,
      mode: match.mode,
      serverTurnIsP1: isP1Turn, // Envia de quem é a vez real
      p1Time: match.p1Time || (17 * 60),
      p2Time: match.p2Time || (17 * 60)
    });
    return;
  }

  // ===========================================================================
  // 2. MATCHMAKING
  // ===========================================================================
  socket.on('find_match', (incomingData) => {
    // Sai de todas as filas
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

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

    const finalMode = requestedMode.toLowerCase().trim() === 'friendly' ? 'friendly' : 'ranked';
    const currentQueue = queues[finalMode];

    console.log(`[SEARCH] ${socket.user.name} entrou na fila: ${finalMode.toUpperCase()}`);

    // Loop para limpar fantasmas
    let opponent = null;
    while (currentQueue.length > 0) {
      const candidate = currentQueue.shift();
      if (candidate.user.id === socket.user.id) continue; // Eu mesmo
      if (!candidate.connected) continue; // Desconectado
      opponent = candidate;
      break;
    }

    if (opponent) {
      startMatch(opponent, socket, finalMode);
    } else {
      currentQueue.push(socket);
      const label = finalMode === 'friendly' ? 'Amistoso (Casual)' : 'Ranqueada (Hardcore)';
      socket.emit('status', `Buscando ${label}...`);
    }
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
    console.log(`[LEAVE] ${socket.user.name} saiu da fila.`);
  });

  // ===========================================================================
  // 3. GAMEPLAY
  // ===========================================================================
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      activeMatches[rId].moveHistory.push(msg);
      // Salva tempos para caso de reconexão
      if (msg.p1Time) activeMatches[rId].p1Time = msg.p1Time;
      if (msg.p2Time) activeMatches[rId].p2Time = msg.p2Time;

      socket.to(rId).emit('game_message', msg);
    }
  });

  socket.on('game_over_report', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      if (activeMatches[rId].disconnectTimeout) clearTimeout(activeMatches[rId].disconnectTimeout);
      delete activeMatches[rId];
      console.log(`[GAME OVER] Relatado pelo cliente. Sala ${rId} fechada.`);
    }
  });

  // ===========================================================================
  // 4. DESCONEXÃO (TIMER 50s)
  // ===========================================================================
  socket.on('disconnect', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
      const match = activeMatches[rId];

      console.log(`[DISCONNECT] Jogador caiu na sala ${rId}. Iniciando timer de 50s.`);
      socket.to(rId).emit('status', 'Oponente desconectou. Aguardando 50s...');
      socket.to(rId).emit('opponent_disconnected', { timeout: 50 });

      if (!match.disconnectTimeout) {
        match.disconnectTimeout = setTimeout(() => {
          if (activeMatches[rId]) {
            console.log(`[TIMEOUT] Tempo esgotado para sala ${rId}. W.O.`);
            io.to(rId).emit('game_message', {
              type: 'game_over',
              reason: 'opponent_disconnected',
              result: 'win_by_wo'
            });
            delete activeMatches[rId];
          }
        }, 50000); // 50 segundos
      }
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();
  p1.join(roomId); p2.join(roomId);
  p1.roomId = roomId; p2.roomId = roomId;

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

  console.log(`[START] Match ${mode.toUpperCase()} na sala ${roomId}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
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
  // 1. LÓGICA DE RECONEXÃO (REJOIN)
  // ===========================================================================
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    // Verifica se o usuário faz parte desta sala
    return (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    const match = activeMatches[existingRoomId];

    // [CORREÇÃO] Se o jogador voltou a tempo, CANCELA a contagem de W.O.
    if (match.disconnectTimeout) {
      console.log(`[REJOIN] ${socket.user.name} voltou em tempo! Cancelando W.O.`);
      clearTimeout(match.disconnectTimeout);
      delete match.disconnectTimeout;
    } else {
      console.log(`[REJOIN] ${socket.user.name} recuperou a sessão na sala ${existingRoomId}`);
    }

    socket.join(existingRoomId);
    socket.roomId = existingRoomId;

    // Avisa o oponente e a si mesmo
    socket.to(existingRoomId).emit('status', `${socket.user.name} reconectou!`);
    socket.to(existingRoomId).emit('opponent_reconnected');

    const isP1 = (match.p1.id === socket.user.id);

    // Atualiza referência do socket ID no objeto da partida
    if (isP1) match.p1.socketId = socket.id;
    else match.p2.socketId = socket.id;

    socket.emit('rejoin_success', {
      isPlayer1: isP1,
      opponent: isP1 ? match.p2 : match.p1,
      history: match.moveHistory,
      mode: match.mode
    });
    return; // Encerra aqui, não executa o resto do connection
  }

  // ===========================================================================
  // 2. MATCHMAKING ROBUSTO (CORREÇÃO DO BUG DO FANTASMA)
  // ===========================================================================
  socket.on('find_match', (incomingData) => {

    // 1. Limpeza: Sai de todas as filas antes de entrar na nova
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

    // [CORREÇÃO] Loop While para limpar sockets mortos ou duplicados
    let opponent = null;

    while (currentQueue.length > 0) {
      const candidate = currentQueue.shift(); // Remove o primeiro da fila

      // Se for eu mesmo (bug do fantasma), ignora
      if (candidate.user.id === socket.user.id) {
        continue;
      }

      // Se o socket caiu da conexão, ignora
      if (!candidate.connected) {
        continue;
      }

      // Achou alguém válido!
      opponent = candidate;
      break;
    }

    if (opponent) {
      startMatch(opponent, socket, modeToUse);
    } else {
      // Ninguém válido encontrado, entra na fila
      currentQueue.push(socket);
      const label = modeToUse === 'friendly' ? 'Amistoso (Casual)' : 'Ranqueada (Hardcore)';
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
      socket.to(rId).emit('game_message', msg);
    }
  });

  socket.on('game_over_report', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      // Se tiver timer rodando, cancela
      if (activeMatches[rId].disconnectTimeout) clearTimeout(activeMatches[rId].disconnectTimeout);

      delete activeMatches[rId];
      console.log(`[GAME OVER] Relatado pelo cliente. Sala ${rId} fechada.`);
    }
  });

  // ===========================================================================
  // 4. DESCONEXÃO E TIMER DE 50s
  // ===========================================================================
  socket.on('disconnect', () => {
    // Sai das filas
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    // Se estiver em partida
    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
      const match = activeMatches[rId];

      console.log(`[DISCONNECT] Jogador caiu na sala ${rId}. Iniciando timer de 50s.`);

      socket.to(rId).emit('status', 'Oponente desconectou. Aguardando 50s...');
      socket.to(rId).emit('opponent_disconnected', { timeout: 50 });

      // Se ainda não tiver um timer de encerramento iniciado
      if (!match.disconnectTimeout) {
        match.disconnectTimeout = setTimeout(() => {
          // Verifica se a partida ainda existe
          if (activeMatches[rId]) {
            console.log(`[TIMEOUT] Tempo esgotado para sala ${rId}. W.O.`);

            // Avisa quem sobrou que ganhou
            io.to(rId).emit('game_message', {
              type: 'game_over',
              reason: 'opponent_disconnected',
              result: 'win_by_wo'
            });

            // LIMPA A SALA DEFINITIVAMENTE
            delete activeMatches[rId];
          }
        }, 50000); // 50 segundos
      }
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();

  // Join Room
  p1.join(roomId);
  p2.join(roomId);
  p1.roomId = roomId;
  p2.roomId = roomId;

  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, socketId: p1.id, elo: p1.user.elo, skins: p1.user.skins },
    p2: { id: p2.user.id, name: p2.user.name, socketId: p2.id, elo: p2.user.elo, skins: p2.user.skins },
    startTime: Date.now(),
    mode: mode,
    moveHistory: []
  };

  // Envia dados P1
  p1.emit('match_found', {
    isPlayer1: true,
    opponent: { name: p2.user.name, skins: p2.user.skins, elo: p2.user.elo },
    mode: mode
  });

  // Envia dados P2
  p2.emit('match_found', {
    isPlayer1: false,
    opponent: { name: p1.user.name, skins: p1.user.skins, elo: p1.user.elo },
    mode: mode
  });

  console.log(`[START] Match ${mode.toUpperCase()} na sala ${roomId}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
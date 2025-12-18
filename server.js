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

let queues = {
  ranked: [],
  friendly: []
};

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
  // 1. LÓGICA DE RECONEXÃO (SIMPLIFICADA)
  // Como decidimos remover o Rejoin no App, o servidor apenas limpa resíduos antigos
  // ===========================================================================
  const oldRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (oldRoomId) {
    console.log(`[CLEANUP] Removendo partida antiga de ${socket.user.name} para nova sessão.`);
    delete activeMatches[oldRoomId];
  }

  // ===========================================================================
  // 2. MATCHMAKING
  // ===========================================================================
  socket.on('find_match', (incomingData) => {
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

    const finalMode = requestedMode.toLowerCase().trim();
    const modeToUse = (finalMode === 'friendly') ? 'friendly' : 'ranked';

    console.log(`[SEARCH] ${socket.user.name} entrou na fila: ${modeToUse.toUpperCase()}`);

    const currentQueue = queues[modeToUse];

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
  // 3. GAMEPLAY
  // ===========================================================================
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const match = activeMatches[rId];
      match.moveHistory.push(msg);

      if (msg.p1Time !== undefined) match.p1Time = msg.p1Time;
      if (msg.p2Time !== undefined) match.p2Time = msg.p2Time;

      socket.to(rId).emit('game_message', msg);

      if (msg.type === 'game_over' || msg.gameOver === true ||
        (match.p1Time <= 0) || (match.p2Time <= 0)) {
        console.log(`[GAME OVER] Encerrando sala ${rId}`);
        delete activeMatches[rId];
        return;
      }
    }
  });

  socket.on('game_over_report', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { type: 'game_over', report_data: data });
      delete activeMatches[rId];
    }
  });

  // ===========================================================================
  // 4. DESCONEXÃO (AJUSTADO PARA ENCERRAR A SALA)
  // ===========================================================================
  socket.on('disconnect', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
      console.log(`[DISCONNECT] Jogador saiu. Encerrando sala ${rId} por W.O. imediato.`);

      // Avisa o oponente que ele venceu porque o outro saiu (App fechado)
      io.to(rId).emit('game_message', {
        type: 'game_over',
        reason: 'opponent_disconnected',
        result: 'win_by_wo'
      });

      delete activeMatches[rId];
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
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
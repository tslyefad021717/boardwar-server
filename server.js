// server.js
// (VERSÃO FINAL BLINDADA: CORRIGE O BUG DO JSON.PARSE)

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

  // --- LÓGICA DE RECONEXÃO ---
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    console.log(`[REJOIN] ${socket.user.name} voltou para sala ${existingRoomId}`);
    const match = activeMatches[existingRoomId];

    // Cancela limpeza se existir
    if (match.gcTimeout) { clearTimeout(match.gcTimeout); delete match.gcTimeout; }

    socket.join(existingRoomId);
    socket.roomId = existingRoomId;
    socket.to(existingRoomId).emit('status', `${socket.user.name} voltou!`);

    const isP1 = (match.p1.id === socket.user.id);

    socket.emit('rejoin_success', {
      isPlayer1: isP1,
      opponent: isP1 ? match.p2 : match.p1,
      history: match.moveHistory,
      mode: match.mode // Devolve o modo para arrumar o título
    });
    return;
  }

  // --- MATCHMAKING ULTRA-ROBUSTO ---
  socket.on('find_match', (incomingData) => {

    // 1. LIMPEZA TOTAL (Sai de todas as filas antes de entrar na nova)
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    // 2. LEITURA INTELIGENTE DO MODO
    let requestedMode = 'ranked'; // Padrão

    try {
      if (typeof incomingData === 'object' && incomingData !== null && incomingData.mode) {
        // Recebeu { mode: 'friendly' }
        requestedMode = incomingData.mode;
      } else if (typeof incomingData === 'string') {
        const cleanStr = incomingData.trim();
        // Tenta ler como JSON, se falhar, usa a string direta
        if (cleanStr.startsWith('{')) {
          const parsed = JSON.parse(cleanStr);
          if (parsed.mode) requestedMode = parsed.mode;
        } else {
          // Recebeu "friendly" puro -> ACEITA! (Correção do bug)
          requestedMode = cleanStr;
        }
      }
    } catch (e) {
      console.log("Erro leitura modo, usando ranked.");
    }

    // Normaliza para minúsculo
    const finalMode = requestedMode.toLowerCase().trim();
    const modeToUse = (finalMode === 'friendly') ? 'friendly' : 'ranked';

    console.log(`[SEARCH] ${socket.user.name} entrou na fila: ${modeToUse.toUpperCase()}`);

    const currentQueue = queues[modeToUse];

    if (currentQueue.length > 0) {
      // ACHOU!
      let opponent = currentQueue.shift();

      // Evita jogar contra si mesmo
      if (opponent.user.id === socket.user.id) {
        currentQueue.push(opponent);
        return;
      }

      if (opponent.connected) {
        startMatch(opponent, socket, modeToUse);
      } else {
        currentQueue.push(socket);
        socket.emit('status', 'Oponente da fila caiu. Aguardando...');
      }
    } else {
      // NÃO ACHOU, ENTRA NA FILA
      currentQueue.push(socket);
      const label = modeToUse === 'friendly' ? 'Amistoso (Casual)' : 'Ranqueada (Hardcore)';
      socket.emit('status', `Buscando ${label}...`);
    }
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
    console.log(`[LEAVE] ${socket.user.name} saiu.`);
  });

  // --- GAMEPLAY ---
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
      delete activeMatches[rId];
      console.log(`[GAME OVER] Sala ${rId} fechada.`);
    }
  });

  socket.on('disconnect', () => {
    // Sai das filas
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    // Lida com desconexão em partida
    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
      socket.to(rId).emit('status', 'Oponente desconectou...');
      socket.to(rId).emit('opponent_disconnected');

      // Garbage Collector (15 min)
      if (!activeMatches[rId].gcTimeout) {
        activeMatches[rId].gcTimeout = setTimeout(() => {
          if (activeMatches[rId]) {
            io.to(rId).emit('game_message', { type: 'game_over', reason: 'afk' });
            delete activeMatches[rId];
          }
        }, 15 * 60 * 1000);
      }
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();
  p1.join(roomId); p2.join(roomId);
  p1.roomId = roomId; p2.roomId = roomId;

  activeMatches[roomId] = {
    p1: p1.user, p2: p2.user,
    startTime: Date.now(),
    mode: mode,
    moveHistory: []
  };

  // Envia dados completos para P1
  p1.emit('match_found', {
    isPlayer1: true,
    opponent: { name: p2.user.name, skins: p2.user.skins, elo: p2.user.elo },
    mode: mode
  });

  // Envia dados completos para P2
  p2.emit('match_found', {
    isPlayer1: false,
    opponent: { name: p1.user.name, skins: p1.user.skins, elo: p1.user.elo },
    mode: mode
  });

  console.log(`[START] Match ${mode.toUpperCase()} na sala ${roomId}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
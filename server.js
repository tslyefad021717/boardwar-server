const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 10000,
  pingInterval: 5000
});

// ===========================================================================
// 1. CONEXÃO COM MONGODB
// ===========================================================================
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
  .then(() => console.log("✅ Conectado ao MongoDB Atlas"))
  .catch(err => console.error("❌ Erro MongoDB:", err.message));

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  elo: { type: Number, default: 1200 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ===========================================================================
// 2. ESTADO GLOBAL
// ===========================================================================
let queues = { ranked: [], friendly: [] };
const activeMatches = {};
const reconnectionTimeouts = {}; // Controle de W.O.

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
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    socket.roomId = existingRoomId;
    socket.join(existingRoomId);
    if (reconnectionTimeouts[existingRoomId]) {
      clearTimeout(reconnectionTimeouts[existingRoomId]);
      delete reconnectionTimeouts[existingRoomId];
    }
    socket.to(existingRoomId).emit('game_message', { type: 'opponent_reconnected' });
    console.log(`[REJOIN] ${socket.user.name} voltou para ${existingRoomId}`);
  }

  // --- REGISTRO ---
  socket.on('register_user', async (data) => {
    try {
      const { userId, username } = data;
      const nameRegex = /^[a-zA-Z0-9_]{3,15}$/;
      if (!username || !nameRegex.test(username)) {
        return socket.emit('register_response', { success: false, message: "Nome inválido!" });
      }
      const existingUser = await User.findOne({ username });
      if (existingUser && existingUser.userId !== userId) {
        return socket.emit('register_response', { success: false, message: "Nome em uso!" });
      }
      let user = await User.findOneAndUpdate(
        { userId }, { username }, { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      socket.user.name = user.username;
      socket.emit('register_response', { success: true, username: user.username, elo: user.elo });
    } catch (e) {
      socket.emit('register_response', { success: false, message: "Erro no servidor." });
    }
  });

  // --- MATCHMAKING ---
  socket.on('find_match', (incomingData) => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
    const mode = (incomingData?.mode?.toLowerCase() === 'friendly') ? 'friendly' : 'ranked';
    const currentQueue = queues[mode];

    let opponent = null;
    while (currentQueue.length > 0) {
      const candidate = currentQueue.shift();
      if (candidate.user.id !== socket.user.id && candidate.connected) {
        opponent = candidate;
        break;
      }
    }

    if (opponent) {
      startMatch(opponent, socket, mode);
    } else {
      currentQueue.push(socket);
      socket.emit('status', `Buscando oponente...`);
    }
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
  });

  // --- GAMEPLAY ---
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const match = activeMatches[rId];
      match.moveHistory.push(msg);
      if (msg.p1Time !== undefined) match.p1Time = msg.p1Time;
      if (msg.p2Time !== undefined) match.p2Time = msg.p2Time;
      socket.to(rId).emit('game_message', msg);
    }
  });

  socket.on('game_over_report', (data) => {
    if (socket.roomId && activeMatches[socket.roomId]) {
      socket.to(socket.roomId).emit('game_message', { type: 'game_over', report_data: data });
    }
  });

  // --- REVANCHE ---
  socket.on('request_rematch', () => {
    if (socket.roomId && activeMatches[socket.roomId]) {
      socket.to(socket.roomId).emit('game_message', { type: 'rematch_requested' });
    }
  });

  socket.on('respond_rematch', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      if (data.accepted) {
        const match = activeMatches[rId];
        match.moveHistory = [];
        match.p1Time = 1020; match.p2Time = 1020;
        io.to(rId).emit('game_message', { type: 'rematch_start' });
      } else {
        io.to(rId).emit('game_message', { type: 'rematch_failed' });
        delete activeMatches[rId];
      }
    }
  });

  socket.on('disconnect', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });
      reconnectionTimeouts[rId] = setTimeout(() => {
        if (activeMatches[rId]) {
          io.to(rId).emit('game_message', {
            type: 'game_over', reason: 'opponent_disconnected', result: 'win_by_wo'
          });
          delete activeMatches[rId];
          delete reconnectionTimeouts[rId];
        }
      }, 15000);
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();
  [p1, p2].forEach(p => { p.join(roomId); p.roomId = roomId; });
  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, elo: p1.user.elo },
    p2: { id: p2.user.id, name: p2.user.name, elo: p2.user.elo },
    mode, moveHistory: [], p1Time: 1020, p2Time: 1020
  };
  p1.emit('match_found', { isPlayer1: true, opponent: { name: p2.user.name, elo: p2.user.elo }, mode });
  p2.emit('match_found', { isPlayer1: false, opponent: { name: p1.user.name, elo: p1.user.elo }, mode });
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
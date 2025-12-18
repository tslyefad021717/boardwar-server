const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose'); // Importando o Mongoose

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 10000,
  pingInterval: 5000
});

// ===========================================================================
// 1. CONEXÃO COM MONGODB ATLAS
// ===========================================================================
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Conectado ao MongoDB Atlas com sucesso!"))
  .catch(err => {
    console.error("❌ Erro ao conectar ao MongoDB:", err.message);
    console.log("⚠️ O servidor continuará rodando, mas sem persistência de dados.");
  });

// Schema do Jogador
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
// 2. VARIÁVEIS DE ESTADO
// ===========================================================================
let queues = {
  ranked: [],
  friendly: []
};

const activeMatches = {};

// Middleware de Autenticação Inicial
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

  // --- REGISTRO / LOGIN DE NICKNAME ÚNICO ---
  socket.on('register_user', async (data) => {
    try {
      const { userId, username } = data;
      if (!username || username.trim().length < 3) {
        return socket.emit('register_response', { success: false, message: "Nome muito curto!" });
      }

      // Verifica se o nome já existe para outro ID
      const existingUser = await User.findOne({ username: username });
      if (existingUser && existingUser.userId !== userId) {
        return socket.emit('register_response', {
          success: false,
          message: "Este nome já está em uso por outro guerreiro!"
        });
      }

      // Upsert: Cria se não existir, atualiza se existir
      let user = await User.findOneAndUpdate(
        { userId: userId },
        { username: username },
        { upsert: true, new: true }
      );

      socket.user.name = user.username;
      socket.user.elo = user.elo;

      socket.emit('register_response', {
        success: true,
        username: user.username,
        elo: user.elo
      });
      console.log(`[AUTH] ${user.username} registrado/logado.`);
    } catch (e) {
      console.error("Erro no register_user:", e);
      socket.emit('register_response', { success: false, message: "Erro ao acessar banco de dados." });
    }
  });

  // Limpeza de resíduos de partidas antigas
  const oldRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (oldRoomId) {
    console.log(`[CLEANUP] Removendo partida antiga de ${socket.user.name}`);
    delete activeMatches[oldRoomId];
  }

  // ===========================================================================
  // 3. MATCHMAKING
  // ===========================================================================
  socket.on('find_match', (incomingData) => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    let requestedMode = 'ranked';
    if (incomingData && incomingData.mode) requestedMode = incomingData.mode;

    const modeToUse = (requestedMode.toLowerCase() === 'friendly') ? 'friendly' : 'ranked';
    console.log(`[SEARCH] ${socket.user.name} em ${modeToUse.toUpperCase()}`);

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
      socket.emit('status', `Buscando oponente...`);
    }
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
  });

  // ===========================================================================
  // 4. GAMEPLAY
  // ===========================================================================
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const match = activeMatches[rId];
      match.moveHistory.push(msg);

      if (msg.p1Time !== undefined) match.p1Time = msg.p1Time;
      if (msg.p2Time !== undefined) match.p2Time = msg.p2Time;

      socket.to(rId).emit('game_message', msg);

      if (msg.type === 'game_over' || msg.gameOver === true || (match.p1Time <= 0) || (match.p2Time <= 0)) {
        console.log(`[GAME OVER] Encerrando sala ${rId}`);
        delete activeMatches[rId];
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

  socket.on('disconnect', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;
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
    p1: { id: p1.user.id, name: p1.user.name, socketId: p1.id, elo: p1.user.elo },
    p2: { id: p2.user.id, name: p2.user.name, socketId: p2.id, elo: p2.user.elo },
    mode: mode,
    moveHistory: [],
    p1Time: 17 * 60,
    p2Time: 17 * 60
  };

  p1.emit('match_found', { isPlayer1: true, opponent: { name: p2.user.name, elo: p2.user.elo }, mode });
  p2.emit('match_found', { isPlayer1: false, opponent: { name: p1.user.name, elo: p1.user.elo }, mode });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
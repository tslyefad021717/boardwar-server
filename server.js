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
  elo: { type: Number, default: 600 },
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
const reconnectionTimeouts = {};

// ===========================================================================
// 3. LÓGICA DE ELO (MANTIDA IGUAL)
// ===========================================================================
function getRankName(elo) {
  if (elo < 500) return "Camponês";
  if (elo < 1000) return "Soldado";
  if (elo < 1500) return "Veterano";
  if (elo < 2000) return "Comandante";
  if (elo < 2500) return "General";
  return "Lenda de Guerra";
}

function calculateEloDelta(result, reason, myScore, oppScore, myElo, oppElo) {
  let delta = 0;
  if (result === 'win') {
    switch (reason) {
      case 'regicide': delta = 10; break;
      case 'dominance': delta = 9; break;
      case 'annihilation': delta = 8; break;
      case 'surrender': delta = 7; break;
      case 'afk': delta = 7; break;
      case 'opponent_disconnected': delta = 7; break;
      case 'time_out': delta = 9; break;
      default: delta = 5;
    }
    if (oppElo > myElo) {
      const diffPercent = ((oppElo - myElo) / myElo) * 100;
      if (diffPercent >= 20) delta += 3;
      else if (diffPercent >= 15) delta += 1;
    }
  } else {
    if (reason === 'quit' || reason === 'opponent_disconnected') return -17;
    if (reason === 'afk') return -10;
    if (reason === 'surrender') return -10;

    let baseLoss = -8;
    let modifiers = 0;
    if (oppScore > 0 && myScore > 0) {
      const perfDiff = ((oppScore - myScore) / myScore) * 100;
      if (perfDiff < 50) modifiers += 4;
      else if (perfDiff < 80) modifiers += 3;
      else if (perfDiff < 100) modifiers += 2;
      else if (perfDiff < 150) modifiers += 1;
    } else if (myScore > 0 && oppScore === 0) {
      modifiers += 4;
    }
    if (myElo > oppElo) {
      const mmrDiff = ((myElo - oppElo) / myElo) * 100;
      if (mmrDiff >= 20) modifiers -= 2;
      else if (mmrDiff >= 15) modifiers -= 1;
    }
    delta = baseLoss + modifiers;
    if (delta > 0) delta = 0;
  }
  return delta;
}

// ===========================================================================
// 4. SOCKET.IO (COM LÓGICA DE SYNC ATUALIZADA)
// ===========================================================================

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  socket.user = {
    id: auth.userId || uuidv4(),
    name: auth.name || 'Guerreiro',
    skins: auth.skins || {},
    elo: 600
  };
  next();
});

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.user.name} (${socket.id})`);

  // --- RECONEXÃO INTELIGENTE ---
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    // Verifica se o usuário faz parte da partida
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    socket.roomId = existingRoomId;
    socket.join(existingRoomId);

    // 1. Cancela o W.O. pois o jogador voltou
    if (reconnectionTimeouts[existingRoomId]) {
      clearTimeout(reconnectionTimeouts[existingRoomId]);
      delete reconnectionTimeouts[existingRoomId];
    }

    // 2. Avisa que voltou
    socket.to(existingRoomId).emit('game_message', { type: 'opponent_reconnected' });

    // 3. [NOVO] Pede ao SOBREVIVENTE (quem não caiu) o estado atual do jogo
    console.log(`[REJOIN] ${socket.user.name} voltou. Pedindo estado atual para o oponente...`);
    socket.to(existingRoomId).emit('request_state_for_reconnection');
  }

  // --- REGISTRO / LOGIN ---
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
        { userId }, { username },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      socket.user.name = user.username;
      socket.user.elo = user.elo;
      socket.emit('register_response', {
        success: true, username: user.username, elo: user.elo, rank: getRankName(user.elo)
      });
    } catch (e) {
      console.error(e);
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

  // --- [NOVO] SYNC RELAY (Sobrevivente envia -> Servidor repassa para quem voltou) ---
  socket.on('provide_game_state', (data) => {
    const rId = socket.roomId;
    if (rId) {
      console.log(`[SYNC] Repassando estado do jogo na sala ${rId}`);
      socket.to(rId).emit('sync_game_state', data);
    }
  });

  // --- EVENTOS DE SISTEMA (Revanche, etc) ---
  socket.on('request_rematch', () => { if (socket.roomId) socket.to(socket.roomId).emit('game_message', { type: 'rematch_requested' }); });
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

  // --- GAME OVER REPORT ---
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;
    if (!rId || !activeMatches[rId]) return;
    const match = activeMatches[rId];
    const userId = socket.user.id;
    try {
      const user = await User.findOne({ userId });
      if (user) {
        const isP1 = match.p1.id === userId;
        const myStartElo = isP1 ? match.p1.elo : match.p2.elo;
        const oppStartElo = isP1 ? match.p2.elo : match.p1.elo;
        const delta = calculateEloDelta(data.result, data.reason, data.myScore || 0, data.oppScore || 0, myStartElo || 600, oppStartElo || 600);

        if (match.mode === 'ranked') {
          let newElo = user.elo + delta;
          if (newElo < 0) newElo = 0;
          user.elo = newElo;
          if (data.result === 'win') user.wins++; else user.losses++;
          await user.save();
          socket.emit('elo_update', { newElo: newElo, delta: delta, rank: getRankName(newElo) });
        }
      }
    } catch (e) { console.error("Erro update Elo:", e); }
    socket.to(rId).emit('game_message', { type: 'game_over', report_data: data });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', async () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      // Inicia contagem regressiva para W.O. (15 segundos)
      reconnectionTimeouts[rId] = setTimeout(async () => {
        if (activeMatches[rId]) {
          const match = activeMatches[rId];
          io.to(rId).emit('game_message', { type: 'game_over', reason: 'opponent_disconnected', result: 'win_by_wo' });

          // Punição Ranked
          if (match.mode === 'ranked') {
            try {
              const quitterId = socket.user.id;
              const quitterUser = await User.findOne({ userId: quitterId });
              if (quitterUser) {
                let newElo = quitterUser.elo - 17;
                if (newElo < 0) newElo = 0;
                quitterUser.elo = newElo;
                quitterUser.losses++;
                await quitterUser.save();
              }
            } catch (e) { }
          }
          delete activeMatches[rId];
          delete reconnectionTimeouts[rId];
        }
      }, 15000);
    }
  });
});

async function startMatch(p1, p2, mode) {
  const roomId = uuidv4();
  p1.join(roomId); p1.roomId = roomId;
  p2.join(roomId); p2.roomId = roomId;
  let p1Elo = 600, p2Elo = 600;
  try {
    const u1 = await User.findOne({ userId: p1.user.id });
    const u2 = await User.findOne({ userId: p2.user.id });
    if (u1) p1Elo = u1.elo;
    if (u2) p2Elo = u2.elo;
  } catch (e) { }

  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, elo: p1Elo },
    p2: { id: p2.user.id, name: p2.user.name, elo: p2Elo },
    mode, moveHistory: [], p1Time: 1020, p2Time: 1020
  };

  p1.emit('match_found', { isPlayer1: true, opponent: { name: p2.user.name, elo: p2Elo, rank: getRankName(p2Elo) }, mode });
  p2.emit('match_found', { isPlayer1: false, opponent: { name: p1.user.name, elo: p1Elo, rank: getRankName(p1Elo) }, mode });
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 20000,
  pingInterval: 10000
});

// ===========================================================================
// 1. CONEXÃO COM MONGODB
// ===========================================================================
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
  .then(() => console.log("✅ Conectado ao MongoDB Atlas"))
  .catch(err => console.error("❌ Erro MongoDB:", err.message));

// --- MAPA DE USUÁRIOS ONLINE (NOVO) ---
// Formato: { "userId": "socketId" }
const onlineUsers = {};

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  elo: { type: Number, default: 600 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  // --- NOVO CAMPO: AMIGOS ---
  friends: [{ type: String }], // Lista de userIds
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
// 3. LÓGICA DE ELO
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
  const res = result?.toLowerCase() || '';
  const rea = reason?.toLowerCase() || '';

  // --- LÓGICA DE VITÓRIA ---
  if (res === 'win' || res === 'victory' || res === 'win_by_wo') {
    switch (rea) {
      case 'regicide': delta = 10; break;
      case 'dominance': delta = 9; break;
      case 'annihilation': delta = 8; break;
      case 'surrender': delta = 7; break;
      case 'afk': delta = 7; break;
      case 'opponent_disconnected': delta = 7; break;
      case 'time_out': delta = 9; break;
      default: delta = 5;
    }

    // Bônus Davi vs Golias
    if (oppElo > myElo) {
      const diffPercent = ((oppElo - myElo) / myElo) * 100;
      if (diffPercent >= 20) {
        delta += 3;
      } else if (diffPercent >= 15) {
        delta += 1;
      }
    }
    return delta;
  }

  // --- LÓGICA DE DERROTA ---
  else {
    if (rea === 'quit' || rea === 'opponent_disconnected') return -17;
    if (rea === 'afk') return -10;
    if (rea === 'surrender') return -10;

    let baseLoss = -8;
    let modifiers = 0;

    if (oppScore > 0 && myScore > 0) {
      const perfDiff = ((oppScore - myScore) / (myScore || 1)) * 100;
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
    return delta > 0 ? 0 : delta;
  }
}

// ===========================================================================
// 4. LÓGICA DE MATCHMAKING DINÂMICO
// ===========================================================================

function findMatchDynamic() {
  const mode = 'ranked';
  const queue = queues[mode];
  if (queue.length < 2) return;

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const p1 = queue[i];
      const p2 = queue[j];

      if (p1.user.id === p2.user.id) continue;

      const waitTime = (Date.now() - Math.min(p1.joinedAt, p2.joinedAt)) / 1000;
      let marginPercent = 5 + (Math.floor(waitTime / 30) * 5);
      if (marginPercent > 30) marginPercent = 30;

      const eloDiff = Math.abs(p1.user.elo - p2.user.elo);
      const avgElo = (p1.user.elo + p2.user.elo) / 2;
      const maxAllowedDiff = avgElo * (marginPercent / 100);

      if (eloDiff <= maxAllowedDiff) {
        queues[mode].splice(j, 1);
        queues[mode].splice(i, 1);
        startMatch(p1, p2, mode);
        return findMatchDynamic();
      }
    }
  }
}

setInterval(findMatchDynamic, 5000);

// ===========================================================================
// 5. SOCKET.IO
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

  // --- REGISTRA ONLINE ---
  onlineUsers[socket.user.id] = socket.id;

  // --- RECONEXÃO ---
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
    socket.to(existingRoomId).emit('request_state_for_reconnection');
  }

  // --- REGISTRO ---
  socket.on('register_user', async (data) => {
    try {
      const { userId, username } = data;
      const nameRegex = /^[a-zA-Z0-9_]{3,15}$/;
      if (!username || !nameRegex.test(username)) {
        return socket.emit('register_response', { success: false, message: "Nome inválido!" });
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
      socket.emit('register_response', { success: false, message: "Erro no servidor." });
    }
  });

  // --- SISTEMA DE AMIGOS (NOVO) ---
  socket.on('add_friend', async (targetName) => {
    try {
      const target = await User.findOne({ username: targetName });
      if (!target) return socket.emit('friend_error', 'Guerreiro não encontrado.');
      if (target.userId === socket.user.id) return socket.emit('friend_error', 'Você não pode adicionar a si mesmo.');

      const me = await User.findOne({ userId: socket.user.id });
      if (!me) return;

      // Limite de 20 amigos
      if (me.friends.length >= 20) return socket.emit('friend_error', 'Limite de 20 amigos atingido!');
      if (me.friends.includes(target.userId)) return socket.emit('friend_error', 'Já é seu amigo.');

      me.friends.push(target.userId);
      await me.save();
      socket.emit('friend_success', `Agora você segue ${target.username}!`);
    } catch (e) { console.error(e); }
  });

  socket.on('get_friends_list', async () => {
    try {
      const me = await User.findOne({ userId: socket.user.id });
      if (!me || !me.friends) return socket.emit('friends_list_data', []);

      const friendsData = await User.find({ userId: { $in: me.friends } })
        .select('userId username elo');

      const processedList = friendsData.map(f => ({
        id: f.userId,
        name: f.username,
        elo: f.elo,
        rank: getRankName(f.elo),
        isOnline: !!onlineUsers[f.userId] // True se estiver no mapa de online
      }));

      socket.emit('friends_list_data', processedList);
    } catch (e) { console.error(e); }
  });

  socket.on('invite_friend', (friendId) => {
    const friendSocketId = onlineUsers[friendId];
    if (friendSocketId) {
      io.to(friendSocketId).emit('game_invite', {
        inviterId: socket.user.id,
        inviterName: socket.user.name
      });
    } else {
      socket.emit('friend_error', 'Amigo está offline ou em batalha.');
    }
  });

  socket.on('accept_invite', (inviterId) => {
    const inviterSocketId = onlineUsers[inviterId];
    if (inviterSocketId) {
      const inviterSocket = io.sockets.sockets.get(inviterSocketId);
      if (inviterSocket) {
        // Remove das filas se estiverem
        queues.ranked = queues.ranked.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);
        queues.friendly = queues.friendly.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);

        // Inicia partida AMISTOSA
        startMatch(inviterSocket, socket, 'friendly');
      } else {
        socket.emit('friend_error', 'Convite expirou (usuário desconectou).');
      }
    }
  });

  // --- MATCHMAKING ---
  socket.on('find_match', (incomingData) => {
    const mode = (incomingData?.mode?.toLowerCase() === 'friendly') ? 'friendly' : 'ranked';

    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (mode === 'friendly') {
      const opponent = queues.friendly.shift();
      if (opponent) startMatch(opponent, socket, 'friendly');
      else queues.friendly.push(socket);
    } else {
      socket.joinedAt = Date.now();
      queues.ranked.push(socket);
      findMatchDynamic();
    }
    socket.emit('status', `Buscando oponente...`);
  });

  socket.on('leave_queue', () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
  });

  // --- GAMEPLAY ---
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      if (msg && typeof msg === 'object') {
        const match = activeMatches[rId];
        match.moveHistory.push(msg);
        socket.to(rId).emit('game_message', msg);
      }
    }
  });

  socket.on('provide_game_state', (data) => {
    if (socket.roomId) socket.to(socket.roomId).emit('sync_game_state', data);
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
        match.p1Time = 1020;
        match.p2Time = 1020;
        io.to(rId).emit('game_message', { type: 'rematch_start' });
      } else {
        io.to(rId).emit('game_message', { type: 'rematch_failed' });
        delete activeMatches[rId];
      }
    }
  });

  socket.on('cancel_rematch', () => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      io.to(rId).emit('game_message', { type: 'rematch_failed' });
      if (reconnectionTimeouts[rId]) {
        clearTimeout(reconnectionTimeouts[rId]);
        delete reconnectionTimeouts[rId];
      }
      delete activeMatches[rId];
    }
  });

  // --- GAME OVER ---
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;
    if (!rId || !activeMatches[rId]) return;
    const match = activeMatches[rId];

    console.log(`[GAME OVER] Sala ${rId} - Result: ${data.result}, Reason: ${data.reason}`);

    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (user && match.mode === 'ranked') {
        const isP1 = match.p1.id === socket.user.id;
        const myStartElo = isP1 ? match.p1.elo : match.p2.elo;
        const oppStartElo = isP1 ? match.p2.elo : match.p1.elo;

        const delta = calculateEloDelta(data.result, data.reason, data.myScore || 0, data.oppScore || 0, myStartElo, oppStartElo);

        let newElo = Math.max(0, user.elo + delta);
        user.elo = newElo;

        const resLower = data.result?.toLowerCase() || '';
        if (resLower.includes('win') || resLower.includes('victory')) {
          user.wins++;
        } else {
          user.losses++;
        }

        await user.save();
        socket.emit('elo_update', { newElo: user.elo, delta, rank: getRankName(user.elo) });
      }
    } catch (e) { console.error("Erro Elo Report:", e); }

    socket.to(rId).emit('game_message', {
      type: 'game_over',
      reason: data.reason,
      result: data.result,
      report_data: data
    });
  });

  // --- DESCONEXÃO ---
  socket.on('disconnect', async () => {
    delete onlineUsers[socket.user.id]; // Remove da lista online

    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      reconnectionTimeouts[rId] = setTimeout(async () => {
        if (activeMatches[rId]) {
          const match = activeMatches[rId];

          io.to(rId).emit('game_message', {
            type: 'game_over',
            reason: 'opponent_disconnected',
            result: 'win_by_wo'
          });

          if (match.mode === 'ranked') {
            try {
              const isP1Quitter = match.p1.id === socket.user.id;
              const quitterId = socket.user.id;
              const winnerId = isP1Quitter ? match.p2.id : match.p1.id;

              const quitter = await User.findOne({ userId: quitterId });
              let quitterElo = 600;

              if (quitter) {
                quitterElo = quitter.elo;
                quitter.elo = Math.max(0, quitter.elo - 17);
                quitter.losses++;
                await quitter.save();
                console.log(`[ELO] Quitter ${quitter.username} perdeu 17 pts.`);
              }

              const winner = await User.findOne({ userId: winnerId });
              if (winner) {
                const delta = calculateEloDelta(
                  'win',
                  'opponent_disconnected',
                  0, 0,
                  winner.elo,
                  quitterElo
                );

                winner.elo += delta;
                winner.wins++;
                await winner.save();

                console.log(`[ELO] Winner ${winner.username} ganhou ${delta} pts.`);
                socket.to(rId).emit('elo_update', {
                  newElo: winner.elo,
                  delta,
                  rank: getRankName(winner.elo)
                });
              }

            } catch (e) {
              console.error("Erro ao atualizar Elos na desconexão:", e);
            }
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

  let u1 = await User.findOne({ userId: p1.user.id });
  let u2 = await User.findOne({ userId: p2.user.id });

  const elo1 = u1 ? u1.elo : 600;
  const elo2 = u2 ? u2.elo : 600;

  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, elo: elo1 },
    p2: { id: p2.user.id, name: p2.user.name, elo: elo2 },
    mode, moveHistory: [], p1Time: 1020, p2Time: 1020
  };

  p1.emit('match_found', { isPlayer1: true, opponent: { name: p2.user.name, elo: elo2, rank: getRankName(elo2) }, mode });
  p2.emit('match_found', { isPlayer1: false, opponent: { name: p1.user.name, elo: elo1, rank: getRankName(elo1) }, mode });
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
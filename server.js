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

// Mapa global: { "userId": "socketId" }
const onlineUsers = {};

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  elo: { type: Number, default: 600 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  friends: [{ type: String }],
  notifications: [{
    type: { type: String },
    data: { type: Object }
  }],
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ===========================================================================
// 2. ESTADO GLOBAL
// ===========================================================================
// Filas separadas para Xadrez e Minigames
let queues = {
  ranked: [],
  friendly: [],
  thief: [], // Substituído archery por thief
  horse_race: [],
  tennis: [],
  king: []
};

const activeMatches = {};
const reconnectionTimeouts = {};
const cleanupTimeouts = {};

// ===========================================================================
// 3. LÓGICA DE ELO
// ===========================================================================
function getRankName(elo) {
  if (elo < 500) return "Camponês";
  if (elo < 750) return "Soldado";
  if (elo < 1000) return "Veterano";
  if (elo < 1500) return "Comandante";
  if (elo < 2000) return "General";
  return "Lenda de Guerra";
}

function calculateEloDelta(result, reason, myScore, oppScore, myElo, oppElo) {
  let delta = 0;
  const res = result?.toLowerCase() || '';
  const rea = reason?.toLowerCase() || '';

  if (res === 'win' || res === 'victory' || res === 'win_by_wo') {
    switch (rea) {
      case 'regicide': delta = 12; break;
      case 'dominance': delta = 10; break;
      case 'time_out': delta = 10; break;
      case 'annihilation': delta = 9; break;
      case 'surrender': delta = 9; break;
      case 'afk': delta = 9; break;
      case 'opponent_disconnected': delta = 9; break;
      default: delta = 6;
    }
    if (oppElo > myElo) {
      const diffPercent = ((oppElo - myElo) / myElo) * 100;
      if (diffPercent >= 20) delta += 3;
      else if (diffPercent >= 15) delta += 1;
    }
    return delta;
  } else {
    if (rea === 'quit' || rea === 'opponent_disconnected') return -17;
    if (rea === 'afk') return -13;
    if (rea === 'surrender') return -11;

    let baseLoss = -9;
    let modifiers = 0;

    if (oppScore < 20) modifiers += 4;
    else if (oppScore >= 20 && oppScore <= 30) modifiers += 3;
    else if (oppScore > 30 && oppScore <= 40) modifiers += 2;
    else if (oppScore > 40 && oppScore <= 50) modifiers += 1;

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
// 4. MATCHMAKING DINÂMICO (Para Ranqueada de Xadrez)
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
      let marginPercent = 10 + (Math.floor(waitTime / 30) * 5);
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
// 5. SOCKET.IO EVENTS
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

  const oldSocketId = onlineUsers[socket.user.id];
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) {
      console.log(`[FIX] Desconectando fantasma de ${socket.user.name}`);
      oldSocket.disconnect(true);
    }
  }

  onlineUsers[socket.user.id] = socket.id;

  // --- RECONEXÃO ---
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    const match = activeMatches[existingRoomId];
    if (!match.isFinished) {
      console.log(`[RECONNECT] Usuário ${socket.user.name} voltou.`);
      socket.roomId = existingRoomId;
      socket.join(existingRoomId);

      if (reconnectionTimeouts[existingRoomId]) {
        clearTimeout(reconnectionTimeouts[existingRoomId]);
        delete reconnectionTimeouts[existingRoomId];
      }

      io.to(existingRoomId).emit('game_message', { type: 'force_full_sync_request' });
      socket.to(existingRoomId).emit('game_message', { type: 'opponent_reconnected' });
    }
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

      if (user.notifications && user.notifications.length > 0) {
        setTimeout(async () => {
          for (const notif of user.notifications) {
            socket.emit(notif.type, notif.data);
          }
          await User.updateOne({ userId: user.userId }, { $set: { notifications: [] } });
        }, 7000);
      }

      socket.user.name = user.username;
      socket.user.elo = user.elo;

      socket.emit('register_response', {
        success: true, username: user.username, elo: user.elo, rank: getRankName(user.elo)
      });
    } catch (e) {
      socket.emit('register_response', { success: false, message: "Erro no servidor." });
    }
  });

  // --- AMIGOS ---
  socket.on('add_friend', async (targetName) => {
    try {
      const target = await User.findOne({ username: targetName });
      if (!target) return socket.emit('friend_error', 'Guerreiro não encontrado.');
      if (target.userId === socket.user.id) return socket.emit('friend_error', 'Erro: Auto-adicionar.');

      const me = await User.findOne({ userId: socket.user.id });
      if (!me) return;

      if (me.friends.length >= 20) return socket.emit('friend_error', 'Limite de amigos atingido!');
      if (me.friends.includes(target.userId)) return socket.emit('friend_error', 'Já é seu amigo.');

      me.friends.push(target.userId);
      await me.save();
      socket.emit('friend_success', `Seguindo ${target.username}!`);

      const targetSocketId = onlineUsers[target.userId];
      const notificationData = { name: socket.user.name };

      if (targetSocketId) {
        io.to(targetSocketId).emit('friend_added_you', notificationData);
      } else {
        target.notifications.push({
          type: 'friend_added_you',
          data: notificationData
        });
        await target.save();
      }
    } catch (e) { console.error(e); }
  });

  socket.on('get_friends_list', async () => {
    try {
      const me = await User.findOne({ userId: socket.user.id });
      if (!me || !me.friends) return socket.emit('friends_list_data', []);

      const friendsData = await User.find({ userId: { $in: me.friends } })
        .select('userId username elo')
        .sort({ elo: -1 });

      const processedList = friendsData.map(f => ({
        id: f.userId,
        name: f.username,
        elo: f.elo,
        rank: getRankName(f.elo),
        isOnline: !!onlineUsers[f.userId]
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
      socket.emit('friend_error', 'Amigo offline.');
    }
  });

  socket.on('accept_invite', (inviterId) => {
    const inviterSocketId = onlineUsers[inviterId];
    if (inviterSocketId) {
      const inviterSocket = io.sockets.sockets.get(inviterSocketId);
      if (inviterSocket) {
        // Limpa filas anteriores
        queues.ranked = queues.ranked.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);
        queues.friendly = queues.friendly.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);
        startMatch(inviterSocket, socket, 'friendly');
      } else {
        socket.emit('friend_error', 'Convite expirou.');
      }
    }
  });

  socket.on('get_leaderboard', async () => {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error("DB Offline");

      const top100 = await User.find({})
        .sort({ elo: -1 })
        .limit(100)
        .select('username elo userId')
        .lean();

      const currentUserId = socket.user ? socket.user.id : "visitor";
      const myUser = await User.findOne({ userId: currentUserId }).select('username elo').lean();

      let myRank = 0;
      let myElo = 600;
      let myName = socket.user ? socket.user.name : "Guerreiro";

      if (myUser) {
        myElo = myUser.elo;
        myName = myUser.username;
        const countAbove = await User.countDocuments({ elo: { $gt: myElo } });
        myRank = countAbove + 1;
      }

      socket.emit('leaderboard_data', {
        top100: top100.map(u => ({ name: u.username, elo: u.elo, id: u.userId })),
        myRank, myElo, myName
      });
    } catch (e) {
      socket.emit('leaderboard_data', {
        top100: [], myRank: 0, myElo: 600, myName: "Guerreiro"
      });
    }
  });

  // =================================================================
  // 🔴 MATCHMAKING UNIFICADO (COM ASYNC PARA EVITAR O ERRO)
  // =================================================================
  socket.on('find_match', async (incomingData) => { // <--- O "async" AQUI É OBRIGATÓRIO
    let mode =
      (typeof incomingData === 'string'
        ? incomingData
        : incomingData?.mode
      )?.toLowerCase();

    if (mode === 'online_ranked' || mode === 'main_ranked') mode = 'ranked';
    if (mode === 'online_friendly' || mode === 'main_friendly') mode = 'friendly';


    console.log(`[QUEUE] Jogador ${socket.user.name} entrou na fila: ${mode}`);

    // ===========================================================
    // A. MINI-GAMES (Lógica nova adicionada)
    // ===========================================================
    // Dentro de socket.on('find_match', ...)
    if (mode && mode.startsWith('competitive_')) {
      let queueName = '';
      // Trocamos archery por thief aqui:
      if (mode === 'competitive_thief' || mode === 'thief_pvp') queueName = 'thief';
      else if (mode === 'competitive_horse' || mode === 'horse_race_pvp') queueName = 'horse_race';
      else if (mode === 'competitive_tennis' || mode === 'tennis_pvp') queueName = 'tennis';
      else if (mode === 'competitive_king' || mode === 'king_pvp') queueName = 'king';

      if (!queueName) return;
      // ... resto da lógica de busca (permanece igual)

      queues[queueName] = queues[queueName].filter(s => s.id !== socket.id);

      let opponent = null;
      while (queues[queueName].length > 0) {
        const candidate = queues[queueName][0];
        if (candidate.connected) {
          opponent = queues[queueName].shift();
          break;
        } else {
          queues[queueName].shift();
        }
      }

      if (opponent) {
        // Envia o modo original para o Flutter saber qual tela abrir
        startMatch(opponent, socket, mode);
      } else {
        queues[queueName].push(socket);
        socket.emit('status', "Buscando oponente...");
      }
      return;
    }

    // ===========================================================
    // B. BATALHA GLOBAL (Lógica antiga restaurada e protegida)
    // ===========================================================

    // 1. Verifica se já está jogando
    const ongoingMatchId = Object.keys(activeMatches).find(roomId => {
      const m = activeMatches[roomId];
      return (m.p1.id === socket.user.id || m.p2.id === socket.user.id) && !m.isFinished;
    });

    if (ongoingMatchId) {
      socket.emit('match_error', 'Você já está em uma batalha!');
      return;
    }

    const chessMode = (mode === 'friendly') ? 'friendly' : 'ranked';

    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (chessMode === 'friendly') {
      const opponent = queues.friendly.shift();
      if (opponent) {
        startMatch(opponent, socket, 'friendly');
      } else {
        queues.friendly.push(socket);
      }
    } else {
      // --- RANKED GLOBAL ---
      // AQUI ESTAVA O ERRO DE AWAIT. COM O ASYNC LÁ EM CIMA, ISSO FUNCIONA.
      try {
        const user = await User.findOne({ userId: socket.user.id });
        if (user) {
          socket.user.elo = user.elo;
          socket.user.name = user.username;
        }
      } catch (err) {
        console.error("Erro ao ler Elo:", err);
      }

      socket.joinedAt = Date.now();
      queues.ranked.push(socket);

      findMatchDynamic();
    }

    socket.emit('status', "Buscando oponente digno...");
  });

  socket.on('leave_queue', () => {
    Object.keys(queues).forEach(k => {
      queues[k] = queues[k].filter(s => s.id !== socket.id);
    });
  });
  // =================================================================
  // 🚑 VACINA ANTI-ZUMBI (PARTE 2 - O QUE FALTOU)
  // =================================================================
  socket.on('leave_game', () => {
    // 1. Procura se o usuário está preso em alguma partida ativa
    const rId = Object.keys(activeMatches).find(roomId => {
      const m = activeMatches[roomId];
      return (m.p1.id === socket.user.id || m.p2.id === socket.user.id) && !m.isFinished;
    });

    if (rId) {
      console.log(`[FORCE EXIT] Jogador ${socket.user.name} forçou saída pelo menu (Sala: ${rId})`);

      // 2. Sai da sala do Socket.io
      socket.leave(rId);

      // 3. Avisa o oponente (opcional, mas educado)
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      // 4. O MAIS IMPORTANTE: Marca a partida como finalizada no servidor
      // Isso impede que a verificação "ongoingMatchId" te bloqueie na próxima busca
      if (activeMatches[rId]) {
        activeMatches[rId].isFinished = true;

        // Se quiser ser radical e apagar da memória na hora:
        // delete activeMatches[rId]; 
      }
    }
  });

  // --- EVENTOS DO JOGO ---
  socket.on('game_move', (msg) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const match = activeMatches[rId];
      if (msg.turnEnded === true) match.isPlayer1Turn = !match.isPlayer1Turn;
      socket.to(rId).emit('game_message', msg);
    }
  });

  socket.on('horse_action', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', {
        type: 'horse_sync',
        lane: data.lane,
        distance: data.distance,
        isFrozen: data.isFrozen,
        action: data.type
      });
    }
  });

  socket.on('king_sync', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) socket.to(rId).emit('game_message', data);
  });

  socket.on('king_turn_change', () => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) socket.to(rId).emit('game_message', { type: 'king_turn_change' });
  });
  // ✅ MOVA PARA CÁ (Dentro do io.on('connection')):
  socket.on('thief_sync', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', {
        type: 'thief_sync',
        grid: data.grid,
        p1Coins: data.p1Coins,
        p2Coins: data.p2Coins,
        isPlayer1Turn: data.isPlayer1Turn
      });
    }
  });

  socket.on('tennis_action', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { ...data, action: data.type, type: 'tennis_sync' });
    }
  });

  socket.on('turn_pass', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      activeMatches[rId].isPlayer1Turn = !activeMatches[rId].isPlayer1Turn;
      socket.to(rId).emit('game_message', { type: 'turn_pass', p1Time: data.p1Time, p2Time: data.p2Time });
    }
  });

  socket.on('check_turn_integrity', (clientThinkIsP1) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      if (clientThinkIsP1 !== activeMatches[rId].isPlayer1Turn) {
        io.to(rId).emit('game_message', { type: 'force_full_sync_request' });
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
        if (cleanupTimeouts[rId]) {
          clearTimeout(cleanupTimeouts[rId]);
          delete cleanupTimeouts[rId];
        }
        const match = activeMatches[rId];
        match.moveHistory = [];
        match.p1Time = 1020;
        match.p2Time = 1020;
        match.isPlayer1Turn = true;
        match.isFinished = false;
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
      delete activeMatches[rId];
    }
  });

  // --- GAME OVER ---
  // =================================================================
  // 6. GAME OVER BLINDADO (CORREÇÃO DEFINITIVA DE DUPLICIDADE)
  // =================================================================
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;
    if (!rId || !activeMatches[rId]) return;

    const match = activeMatches[rId];

    // 🔴 TRAVA 1: Se já acabou, ignora.
    if (match.isFinished) return;

    // 🔴 TRAVA 2: Semáforo de processamento (Evita que P1 e P2 entrem aqui ao mesmo tempo)
    if (match.processingGameOver) return;
    match.processingGameOver = true;

    // Cancela timers de desconexão para não dar WO falso
    if (reconnectionTimeouts[rId]) {
      clearTimeout(reconnectionTimeouts[rId]);
      delete reconnectionTimeouts[rId];
    }

    console.log(`[GAME OVER] Sala ${rId} - Result: ${data.result}, Reason: ${data.reason}`);

    try {
      // Só calcula Elo se for Rankeada E se ainda não tivermos calculado (redundância)
      if (match.mode === 'ranked' && !match.eloCalculated) {
        match.eloCalculated = true; // Marca que já calculou

        const p1Data = match.p1;
        const p2Data = match.p2;

        // Busca usuários frescos do banco
        const user1 = await User.findOne({ userId: p1Data.id });
        const user2 = await User.findOne({ userId: p2Data.id });

        if (user1 && user2) {
          // Define quem reportou (para confiar nos dados certos)
          const isReporterP1 = (socket.user.id === p1Data.id);

          let winner, loser;
          let winnerScore = 0, loserScore = 0;

          // Lógica de quem ganhou baseada no report recebido
          if (['win', 'victory'].includes(data.result?.toLowerCase())) {
            winner = isReporterP1 ? user1 : user2;
            loser = isReporterP1 ? user2 : user1;
            winnerScore = isReporterP1 ? (data.myScore || 0) : (data.oppScore || 0);
            loserScore = isReporterP1 ? (data.oppScore || 0) : (data.myScore || 0);
          } else {
            winner = isReporterP1 ? user2 : user1;
            loser = isReporterP1 ? user1 : user2;
            winnerScore = isReporterP1 ? (data.oppScore || 0) : (data.myScore || 0);
            loserScore = isReporterP1 ? (data.myScore || 0) : (data.oppScore || 0);
          }

          // Salva Elos antigos para o cálculo
          const winnerEloBefore = winner.elo;
          const loserEloBefore = loser.elo;

          // Calcula Deltas
          const realWinDelta = calculateEloDelta('win', data.reason, winnerScore, loserScore, winnerEloBefore, loserEloBefore);
          const finalWinPoints = Math.abs(realWinDelta) > 0 ? Math.abs(realWinDelta) : 10;
          const realLossDelta = calculateEloDelta('loss', data.reason, loserScore, winnerScore, loserEloBefore, winnerEloBefore);

          console.log(`[ELO CALC] Winner (${winner.username}): +${finalWinPoints} | Loser (${loser.username}): ${realLossDelta}`);

          // Aplica no Banco
          winner.elo += finalWinPoints;
          winner.wins++;
          loser.elo = Math.max(0, loser.elo + realLossDelta);
          loser.losses++;

          await Promise.all([winner.save(), loser.save()]);

          // Envia atualização de Elo para os clientes (com delay visual)
          setTimeout(() => {
            const s1 = onlineUsers[winner.userId];
            const s2 = onlineUsers[loser.userId];
            // Envia apenas se o socket ainda estiver conectado
            if (s1 && io.sockets.sockets.get(s1))
              io.to(s1).emit('elo_update', { newElo: winner.elo, delta: finalWinPoints, rank: getRankName(winner.elo) });
            if (s2 && io.sockets.sockets.get(s2))
              io.to(s2).emit('elo_update', { newElo: loser.elo, delta: realLossDelta, rank: getRankName(loser.elo) });
          }, 1500);
        }
      }
    } catch (e) {
      console.error("Erro Crítico no Elo:", e);
      // Se der erro, destrava para tentar processar de novo (opcional, mas perigoso)
      // match.processingGameOver = false; 
    }

    // Marca como finalizado OFICIALMENTE após processar o Elo
    match.isFinished = true;

    // Avisa a todos na sala que acabou
    io.to(rId).emit('game_message', {
      type: 'game_over',
      reason: data.reason,
      result: data.result,
      winnerId: socket.user.id
    });

    // Limpeza da Sala
    // Limpeza da Sala
    if (cleanupTimeouts[rId]) clearTimeout(cleanupTimeouts[rId]);
    const isMinigame = ['thief_pvp', 'horse_race_pvp', 'tennis_pvp', 'king_pvp'].includes(match.mode); // Adicione 'thief_pvp' aqui

    cleanupTimeouts[rId] = setTimeout(() => {
      if (activeMatches[rId]) {
        delete activeMatches[rId];
        console.log(`[CLEANUP] Sala ${rId} limpa.`);
      }
    }, isMinigame ? 4000 : 30000);
  });

  socket.on('disconnect', async () => {
    const currentSocketId = onlineUsers[socket.user.id];
    if (currentSocketId && currentSocketId !== socket.id) return;

    if (onlineUsers[socket.user.id] === socket.id) delete onlineUsers[socket.user.id];

    Object.keys(queues).forEach(k => {
      queues[k] = queues[k].filter(s => s.id !== socket.id);
    });

    const rId = socket.roomId;
    if (rId && activeMatches[rId] && !activeMatches[rId].isFinished) {
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      reconnectionTimeouts[rId] = setTimeout(async () => {
        if (activeMatches[rId] && !activeMatches[rId].isFinished) {
          const isUserBack = onlineUsers[socket.user.id];
          if (!isUserBack) {
            const match = activeMatches[rId];
            match.isFinished = true;
            io.to(rId).emit('game_message', { type: 'game_over', reason: 'opponent_disconnected', result: 'win_by_wo' });

            // Punição WO
            if (match.mode === 'ranked') {
              try {
                const quitter = await User.findOne({ userId: socket.user.id });
                const winnerId = (match.p1.id === socket.user.id) ? match.p2.id : match.p1.id;
                const winner = await User.findOne({ userId: winnerId });

                if (quitter && winner) {
                  quitter.elo = Math.max(0, quitter.elo - 17);
                  quitter.losses++;
                  await quitter.save();

                  const delta = calculateEloDelta('win', 'opponent_disconnected', 0, 0, winner.elo, quitter.elo);
                  const points = Math.abs(delta) > 0 ? Math.abs(delta) : 10;
                  winner.elo += points;
                  winner.wins++;
                  await winner.save();

                  const sWinner = onlineUsers[winner.userId];
                  if (sWinner) io.to(sWinner).emit('elo_update', { newElo: winner.elo, delta: points, rank: getRankName(winner.elo) });
                }
              } catch (e) { }
            }
            delete activeMatches[rId];
          }
        }
      }, 25000);
    }
  });
});

// 🔴 CORRIGIDO: startMatch COM TUDO O QUE PRECISA
async function startMatch(p1, p2, mode) {
  const roomId = uuidv4();
  p1.join(roomId); p1.roomId = roomId;
  p2.join(roomId); p2.roomId = roomId;

  let mapSeed = 0;
  if (mode && mode.includes('horse')) {
    mapSeed = Math.floor(Math.random() * 1000000);
  }

  let u1 = await User.findOne({ userId: p1.user.id });
  let u2 = await User.findOne({ userId: p2.user.id });

  const elo1 = u1 ? u1.elo : 600;
  const elo2 = u2 ? u2.elo : 600;

  activeMatches[roomId] = {
    p1: { id: p1.user.id, name: p1.user.name, elo: elo1 },
    p2: { id: p2.user.id, name: p2.user.name, elo: elo2 },
    mode,
    moveHistory: [],
    p1Time: 1020,
    p2Time: 1020,
    isPlayer1Turn: true,
    isFinished: false
  };

  // Payload Universal (Funciona para Xadrez e Minigames)
  const p1Payload = {
    type: 'match_start', // CRUCIAL para o Flutter entender
    isPlayer1: true,
    opponent: { name: p2.user.name, elo: elo2, rank: getRankName(elo2) },
    mode: mode,
    mapSeed: (mode && mode.includes('horse')) ? mapSeed : 0
  };

  const p2Payload = {
    type: 'match_start',
    isPlayer1: false,
    opponent: { name: p1.user.name, elo: elo1, rank: getRankName(elo1) },
    mode: mode,
    mapSeed: (mode && mode.includes('horse')) ? mapSeed : 0
  };

  // Envia no canal game_message (que o OnlineService escuta)
  p1.emit('game_message', p1Payload);
  p2.emit('game_message', p2Payload);

  // Envia também no canal antigo para garantir
  //p1.emit('match_found', p1Payload);
  // p2.emit('match_found', p2Payload);

  console.log(`[MATCH START] Sala ${roomId} criada. Modo: ${mode}. ${p1.user.name} vs ${p2.user.name}`);
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
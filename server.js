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
  rankedGamesTotal: { type: Number, default: 0 }, // Novo: Contagem vitalícia de ranqueadas
  silverCoins: { type: Number, default: 0 },
  goldCoins: { type: Number, default: 0 },
  friends: [{ type: String }],
  notifications: [{
    type: { type: String },
    data: { type: Object }
  }],
  dailyTasks: {
    date: { type: String, default: "" },
    gamesPlayed: { type: Number, default: 0 },
    gamesClaimed: { type: Boolean, default: false },
    trainingDone: { type: Boolean, default: false },
    trainingClaimed: { type: Boolean, default: false },
    rankedPlayed: { type: Number, default: 0 },
    rankedPlayedClaimed: { type: Boolean, default: false },
    rankedWins: { type: Number, default: 0 },
    rankedWinsClaimed: { type: Boolean, default: false },
    trainingGamesPlayed: { type: Number, default: 0 },
    trainingGamesClaimed: { type: Boolean, default: false },
    // NOVA MISSÃO:
    botGamesPlayed: { type: Number, default: 0 },
    botGamesClaimed: { type: Boolean, default: false }
  },
  lifetimeTasks: {
    ranked50Claimed: { type: Boolean, default: false },
    ranked200Claimed: { type: Boolean, default: false },
    ranked500Claimed: { type: Boolean, default: false },
    ranked1000Claimed: { type: Boolean, default: false }
  },
  loginReward: {
    lastLoginDate: { type: String, default: "" },
    currentStreak: { type: Number, default: 0 },
    todayClaimed: { type: Boolean, default: false }
  },
  ownedEmojis: [{ type: String }],
  equippedEmojis: { type: [String], default: ["", "", "", "", "", "", "", ""] },

  ownedMaps: [{ type: String }],
  equippedMap: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ===========================================================================
// FUNÇÕES DE TEMPO E ESTATÍSTICAS
// ===========================================================================
// ===========================================================================
// FUNÇÕES DE TEMPO E ESTATÍSTICAS
// ===========================================================================
function getTodayString() {
  const dataBR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return `${dataBR.getFullYear()}-${dataBR.getMonth() + 1}-${dataBR.getDate()}`;
}

function getDiffDays(date1Str, date2Str) {
  if (!date1Str || !date2Str) return 999;
  const d1 = date1Str.split('-');
  const d2 = date2Str.split('-');
  const date1 = new Date(d1[0], d1[1] - 1, d1[2], 12, 0, 0);
  const date2 = new Date(d2[0], d2[1] - 1, d2[2], 12, 0, 0);
  const diffTime = date2 - date1;
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

async function processPostMatchStats(userId, mode, result, isBot = false) {
  try {
    const user = await User.findOne({ userId });
    if (!user) return;

    const today = getTodayString();

    if (user.dailyTasks.date !== today) {
      user.dailyTasks = {
        date: today,
        gamesPlayed: 0, gamesClaimed: false,
        trainingDone: false, trainingClaimed: false,
        rankedPlayed: 0, rankedPlayedClaimed: false,
        rankedWins: 0, rankedWinsClaimed: false,
        trainingGamesPlayed: 0, trainingGamesClaimed: false,
        botGamesPlayed: 0, botGamesClaimed: false
      };
      user.markModified('dailyTasks');
    } else {
      if (user.dailyTasks.rankedPlayed == null) user.dailyTasks.rankedPlayed = 0;
      if (user.dailyTasks.rankedWins == null) user.dailyTasks.rankedWins = 0;
      if (user.dailyTasks.trainingGamesPlayed == null) user.dailyTasks.trainingGamesPlayed = 0;
      if (user.dailyTasks.botGamesPlayed == null) user.dailyTasks.botGamesPlayed = 0;
    }

    user.dailyTasks.gamesPlayed++;

    // CORREÇÃO MÁSTER: Só conta como "Jogar contra PC" se NÃO for partida ranqueada.
    // Assim o seu "Fake Ranked" continua em segredo absoluto.
    if (isBot && mode !== 'ranked') {
      user.dailyTasks.botGamesPlayed++;
    }

    if (mode === 'ranked') {
      user.rankedGamesTotal = (user.rankedGamesTotal || 0) + 1;
      user.dailyTasks.rankedPlayed++;
      const isWin = ['win', 'victory', 'win_by_wo'].includes((result || '').toLowerCase());
      if (isWin) user.dailyTasks.rankedWins++;
    }

    // CORREÇÃO DOS MINIJOGOS: Lê qualquer palavra-chave independente do modo exato do flutter
    const safeMode = (mode || '').toLowerCase();
    const isMinigame = safeMode.includes('thief') ||
      safeMode.includes('horse') ||
      safeMode.includes('tennis') ||
      safeMode.includes('king') ||
      safeMode.includes('queen');

    if (isMinigame) {
      user.dailyTasks.trainingGamesPlayed++;
    }

    user.markModified('dailyTasks');
    await user.save();
  } catch (e) {
    console.error("Erro ao incrementar estatísticas pós-partida:", e);
  }
}

// ===========================================================================
// CATÁLOGO DA LOJA (PREÇOS E ITENS)
// ===========================================================================
const STORE_CATALOG = {
  'emoji_sweat': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_laugh': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_angry': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_love': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_thumbup': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_thumbdown': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_punch': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'emoji_cool': { priceSilver: 100, priceGold: 10, type: 'emoji' },
  'map_zumbi': { priceSilver: 1000, priceGold: 100, type: 'map' },
};
// ===========================================================================
// 2. ESTADO GLOBAL
// ===========================================================================
// Filas separadas para Xadrez e Minigames
let queues = {
  ranked: [],
  friendly: [],
  thief: [],
  horse_race: [],
  tennis: [],
  king: [],
  queen: [] // <--- ADICIONE ESTA LINHA
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
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function incrementDailyGame(userId) {
  try {
    const user = await User.findOne({ userId });
    if (user && user.dailyTasks.date === getTodayString()) {
      user.dailyTasks.gamesPlayed++;
      await user.save();
    }
  } catch (e) {
    console.error("Erro ao incrementar partida diária:", e);
  }
}
// ===========================================================================
// 4. MATCHMAKING DINÂMICO (Para Ranqueada de Xadrez)
// ===========================================================================
// ===========================================================================
// 4. MATCHMAKING DINÂMICO (SEM FILTRO DE ELO - MATCH INSTANTÂNEO)
// ===========================================================================
function findMatchDynamic() {
  const mode = 'ranked';
  const queue = queues[mode];

  // Se não tem pelo menos 2 pessoas na fila, não faz nada
  if (queue.length < 2) return;

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const p1 = queue[i];
      const p2 = queue[j];

      // Proteção básica: Evita parear o jogador com ele mesmo (se ele bugar a fila)
      if (p1.user.id === p2.user.id) continue;

      // Achou dois jogadores diferentes? É MATCH IMEDIATO! Não importa o Elo ou o tempo.

      // Remove da fila (Sempre remova o de índice MAIOR primeiro para não quebrar o array)
      queues[mode].splice(j, 1);
      queues[mode].splice(i, 1);

      startMatch(p1, p2, mode);

      // Chama a função de novo para parear o resto da fila, se houver mais de 2 pessoas
      return findMatchDynamic();
    }
  }
}

// Roda a cada 2 segundos (bem rápido) para garantir que o servidor crie a sala 

setInterval(findMatchDynamic, 2000);

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
  // --- REGISTRO ---
  socket.on('register_user', async (data) => {
    try {
      let { userId, username } = data;

      username = username ? username.trim() : "";

      const nameRegex = /^[\p{L}\p{N} _\-\.@]{3,15}$/u;

      if (!username || !nameRegex.test(username)) {
        return socket.emit('register_response', {
          success: false,
          message: "Nome inválido! Use 3-15 caracteres (Letras globais, números ou . - _ @)."
        });
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
        success: true,
        username: user.username,
        elo: user.elo,
        rank: getRankName(user.elo),
        silverCoins: user.silverCoins,
        goldCoins: user.goldCoins
      });
    } catch (e) {
      console.error(e);
      socket.emit('register_response', { success: false, message: "Erro no servidor ou nome já em uso." });
    }
  });
  // ===========================================================================
  // SISTEMA DE TAREFAS DIÁRIAS E RECOMPENSAS
  // ===========================================================================
  // ===========================================================================
  // SISTEMA DE TAREFAS DIÁRIAS, VITALÍCIAS E RECOMPENSAS DE LOGIN
  // ===========================================================================
  socket.on('get_tasks', async () => {
    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (!user) return;

      const today = getTodayString();

      // Reset de Tarefas Diárias
      if (user.dailyTasks.date !== today) {
        user.dailyTasks = {
          date: today,
          gamesPlayed: 0, gamesClaimed: false,
          trainingDone: false, trainingClaimed: false,
          rankedPlayed: 0, rankedPlayedClaimed: false,
          rankedWins: 0, rankedWinsClaimed: false,
          trainingGamesPlayed: 0, trainingGamesClaimed: false,
          botGamesPlayed: 0, botGamesClaimed: false
        };
        user.markModified('dailyTasks');
      } else {
        // VACINA VISUAL: Impede que as barras no Flutter fiquem vazias
        if (user.dailyTasks.rankedPlayed == null) user.dailyTasks.rankedPlayed = 0;
        if (user.dailyTasks.rankedWins == null) user.dailyTasks.rankedWins = 0;
        if (user.dailyTasks.trainingGamesPlayed == null) user.dailyTasks.trainingGamesPlayed = 0;
        if (user.dailyTasks.botGamesPlayed == null) user.dailyTasks.botGamesPlayed = 0;
      }

      // Verificação de Quebra de Login (Streak)
      if (!user.loginReward) {
        user.loginReward = { lastLoginDate: "", currentStreak: 0, todayClaimed: false };
      }

      if (user.loginReward.lastLoginDate !== today) {
        const diff = getDiffDays(user.loginReward.lastLoginDate, today);

        // Se a diferença for maior que 1 dia, perdeu a ofensiva
        if (diff > 1 && user.loginReward.lastLoginDate !== "") {
          user.loginReward.currentStreak = 0;
        }

        user.loginReward.todayClaimed = false;
        user.loginReward.lastLoginDate = today;
        user.markModified('loginReward');
      }

      await user.save();

      socket.emit('tasks_data', {
        dailyTasks: user.dailyTasks,
        lifetimeTasks: user.lifetimeTasks || {},
        loginReward: user.loginReward,
        rankedGamesTotal: user.rankedGamesTotal || 0
      });
    } catch (e) {
      console.error("Erro ao buscar tarefas:", e);
    }
  });
  socket.on('equip_map', async (data) => {
    try {
      const { mapId } = data;

      const user = await User.findOne({ userId: socket.user.id });
      if (!user) return;

      // 🔴 NOVA LÓGICA: Se o aplicativo enviar vazio, significa "Desequipar"
      if (mapId === "") {
        user.equippedMap = "";
        user.markModified('equippedMap');
        await user.save();
        return socket.emit('equip_success', { equippedMap: "" });
      }

      // Validação normal se for equipar um mapa existente
      if (!user.ownedMaps.includes(mapId)) {
        return socket.emit('equip_error', "Você não possui esse mapa.");
      }

      user.equippedMap = mapId;
      user.markModified('equippedMap');
      await user.save();

      socket.emit('equip_success', { equippedMap: mapId });

    } catch (e) {
      console.error("Erro ao equipar mapa:", e);
      socket.emit('equip_error', "Erro ao equipar mapa.");
    }
  });

  socket.on('claim_task', async (taskType) => {
    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (!user) return;

      let rewardSilver = 0;
      let rewardGold = 0;

      // --- VALIDAÇÃO DIÁRIA ---
      if (taskType === 'games' && user.dailyTasks.gamesPlayed >= 3 && !user.dailyTasks.gamesClaimed) {
        user.dailyTasks.gamesClaimed = true;
        rewardSilver = 25;
      } else if (taskType === 'training' && user.dailyTasks.trainingDone && !user.dailyTasks.trainingClaimed) {
        user.dailyTasks.trainingClaimed = true;
        rewardSilver = 10;
      } else if (taskType === 'ranked_played' && user.dailyTasks.rankedPlayed >= 3 && !user.dailyTasks.rankedPlayedClaimed) {
        user.dailyTasks.rankedPlayedClaimed = true;
        rewardSilver = 50;
      } else if (taskType === 'ranked_wins' && user.dailyTasks.rankedWins >= 1 && !user.dailyTasks.rankedWinsClaimed) {
        user.dailyTasks.rankedWinsClaimed = true;
        rewardSilver = 50;
      } else if (taskType === 'training_games' && user.dailyTasks.trainingGamesPlayed >= 1 && !user.dailyTasks.trainingGamesClaimed) {
        user.dailyTasks.trainingGamesClaimed = true;
        rewardSilver = 25;
      } else if (taskType === 'bot_games' && user.dailyTasks.botGamesPlayed >= 2 && !user.dailyTasks.botGamesClaimed) {
        user.dailyTasks.botGamesClaimed = true;
        rewardSilver = 50;

        // --- VALIDAÇÃO VITALÍCIA (LIFETIME) ---
      } else if (taskType === 'lifetime_50' && (user.rankedGamesTotal || 0) >= 50 && !user.lifetimeTasks.ranked50Claimed) {
        user.lifetimeTasks.ranked50Claimed = true;
        rewardSilver = 100;
      } else if (taskType === 'lifetime_200' && (user.rankedGamesTotal || 0) >= 200 && !user.lifetimeTasks.ranked200Claimed) {
        user.lifetimeTasks.ranked200Claimed = true;
        rewardSilver = 250;
      } else if (taskType === 'lifetime_500' && (user.rankedGamesTotal || 0) >= 500 && !user.lifetimeTasks.ranked500Claimed) {
        user.lifetimeTasks.ranked500Claimed = true;
        rewardSilver = 500;
      } else if (taskType === 'lifetime_1000' && (user.rankedGamesTotal || 0) >= 1000 && !user.lifetimeTasks.ranked1000Claimed) {
        user.lifetimeTasks.ranked1000Claimed = true;
        rewardSilver = 5000;

        // --- LOGIN DIÁRIO DE 30 DIAS ---
      } else if (taskType === 'login_reward' && !user.loginReward.todayClaimed) {
        user.loginReward.todayClaimed = true;
        user.loginReward.currentStreak++;

        if (user.loginReward.currentStreak === 30) {
          rewardGold = 30;
          user.loginReward.currentStreak = 0; // Reinicia após pegar o prêmio master
        } else {
          rewardSilver = 10;
        }
      }

      // --- ENTREGA DA RECOMPENSA ---
      if (rewardSilver > 0 || rewardGold > 0) {
        user.silverCoins += rewardSilver;
        user.goldCoins += rewardGold;
        await user.save();

        socket.emit('task_claimed_success', {
          taskType: taskType,
          rewardSilver: rewardSilver,
          rewardGold: rewardGold,
          newSilver: user.silverCoins,
          newGold: user.goldCoins,
          dailyTasks: user.dailyTasks,
          lifetimeTasks: user.lifetimeTasks,
          loginReward: user.loginReward
        });
      } else {
        socket.emit('task_error', "Não foi possível coletar a recompensa.");
      }
    } catch (e) {
      console.error("Erro ao coletar tarefa:", e);
    }
  });

  // --- AMIGOS ---
  socket.on('add_friend', async (targetName) => {
    try {
      const target = await User.findOne({ username: targetName });
      if (!target) return socket.emit('friend_error', 'friends.error_not_found');
      if (target.userId === socket.user.id) return socket.emit('friend_error', 'friends.error_self');

      const me = await User.findOne({ userId: socket.user.id });
      if (!me) return;

      if (me.friends.length >= 20) return socket.emit('friend_error', 'friends.error_limit');
      if (me.friends.includes(target.userId)) return socket.emit('friend_error', 'friends.error_already');

      me.friends.push(target.userId);
      await me.save();
      socket.emit('friend_success', { key: 'friends.follow_success', args: { name: target.username } });

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
      socket.emit('friend_error', 'friends.error_offline');
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
        socket.emit('friend_error', 'friends.error_invite_expired');
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
      else if (mode === 'competitive_queen' || mode === 'queen_pvp') queueName = 'queen';

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
      socket.emit('match_error', 'online.already_playing');
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
        socket.emit('status', 'online.searching_status');
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

    socket.emit('status', 'online.searching_title');
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
  socket.on('emoji', (data) => {
    const rId = socket.roomId;

    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', {
        type: 'emoji',
        emoji: String(data.emoji).substring(0, 5),
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        anim: data.anim
      });
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

  // <--- COLE ISTO JUNTO AOS OUTROS EVENTOS DE JOGO
  socket.on('queen_sync', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      // Repassa exatamente o que o cliente mandou para a sala
      socket.to(rId).emit('game_message', data);
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

  // ===========================================================================
  // SISTEMA DE LOJA E INVENTÁRIO (COMPRA E EQUIPAMENTO)
  // ===========================================================================
  socket.on('get_inventory', async () => {
    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (user) {
        socket.emit('inventory_data', {
          ownedEmojis: user.ownedEmojis || [],
          equippedEmojis: user.equippedEmojis || ["", "", "", "", "", "", "", ""],
          ownedMaps: user.ownedMaps || [],
          equippedMap: user.equippedMap || ''
        });
      }
    } catch (e) {
      console.error("Erro ao buscar inventário:", e);
    }
  });

  socket.on('buy_item', async (data) => {
    try {
      const { itemId, currency } = data;
      const item = STORE_CATALOG[itemId];
      if (!item) {
        return socket.emit('buy_error', "Item não encontrado no catálogo.");
      }

      const user = await User.findOne({ userId: socket.user.id });
      if (!user) return;

      if (!user.ownedEmojis) user.ownedEmojis = [];
      if (!user.ownedMaps) user.ownedMaps = [];

      if (item.type === 'emoji' && user.ownedEmojis.includes(itemId)) {
        return socket.emit('buy_error', "Você já possui este item.");
      }

      if (item.type === 'map' && user.ownedMaps.includes(itemId)) {
        return socket.emit('buy_error', "Você já possui este mapa.");
      }

      if (currency === 'gold') {
        if (user.goldCoins < item.priceGold) {
          return socket.emit('buy_error', "Ouro insuficiente para a compra.");
        }
        user.goldCoins -= item.priceGold;
      } else {
        if (user.silverCoins < item.priceSilver) {
          return socket.emit('buy_error', "Prata insuficiente para a compra.");
        }
        user.silverCoins -= item.priceSilver;
      }

      if (item.type === 'emoji') {
        user.ownedEmojis.push(itemId);
      }

      if (item.type === 'map') {
        user.ownedMaps.push(itemId);
        user.markModified('ownedMaps');
      }

      await user.save();

      socket.emit('buy_success', {
        itemId: itemId,
        newSilver: user.silverCoins,
        newGold: user.goldCoins,
        ownedEmojis: user.ownedEmojis,
        ownedMaps: user.ownedMaps
      });

    } catch (e) {
      console.error("Erro ao processar compra:", e);
      socket.emit('buy_error', "Ocorreu um erro ao processar a compra.");
    }
  });

  socket.on('equip_emoji', async (data) => {
    try {
      const { slotIndex, itemId } = data;

      if (slotIndex < 0 || slotIndex > 7) return;

      const user = await User.findOne({ userId: socket.user.id });
      if (!user) return;

      if (itemId !== "" && !user.ownedEmojis.includes(itemId)) {
        return socket.emit('equip_error', "Você não possui este emoji para equipar.");
      }

      if (!user.equippedEmojis || user.equippedEmojis.length !== 8) {
        user.equippedEmojis = ["", "", "", "", "", "", "", ""];
      }

      user.equippedEmojis[slotIndex] = itemId;
      await user.save();

      socket.emit('equip_success', {
        equippedEmojis: user.equippedEmojis
      });

    } catch (e) {
      console.error("Erro ao equipar emoji:", e);
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
  // =================================================================
  // 🤖 NOVO: GAME OVER PARA BOTS (PARA ATUALIZAR RANKING GLOBAL)
  // =================================================================
  // =================================================================
  // 🤖 NOVO: GAME OVER PARA BOTS (PARA ATUALIZAR RANKING GLOBAL)
  // =================================================================
  // =================================================================
  // EVENTO DE TREINO (MISSÃO 2)
  // =================================================================
  socket.on('report_training', async () => {
    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (user && user.dailyTasks.date === getTodayString() && !user.dailyTasks.trainingDone) {
        user.dailyTasks.trainingDone = true;
        await user.save();
        console.log(`[TASKS] ${user.username} completou a missão de treino!`);
      }
    } catch (e) {
      console.error("Erro ao reportar treino:", e);
    }
  });
  socket.on('report_minigame_played', async () => {
    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (user && user.dailyTasks.date === getTodayString()) {
        user.dailyTasks.trainingGamesPlayed++;
        await user.save();
        console.log(`[TASKS] ${user.username} jogou um minijogo e a missão contou!`);
      }
    } catch (e) {
      console.error("Erro ao reportar minigame:", e);
    }
  });

  // =================================================================
  // 🤖 GAME OVER PARA BOTS
  // =================================================================
  // =================================================================
  // 🤖 GAME OVER PARA BOTS
  // =================================================================
  socket.on('report_bot_game_over', async (data) => {
    try {
      const { result, reason, myScore, oppScore, opponentId, mode } = data;
      const myUserId = socket.user.id;

      const human = await User.findOne({ userId: myUserId });
      const bot = await User.findOne({ userId: opponentId });

      // CORREÇÃO: O if principal agora só exige que o humano exista
      if (human) {
        if (mode === 'ranked' && bot) {
          const humanDelta = calculateEloDelta(result, reason, myScore, oppScore, human.elo, bot.elo);

          const botResult = (result === 'win' || result === 'victory') ? 'loss' : 'win';
          const botDelta = calculateEloDelta(botResult, reason, oppScore, myScore, bot.elo, human.elo);

          human.elo = Math.max(0, human.elo + humanDelta);
          bot.elo = Math.max(0, bot.elo + botDelta);

          console.log(`[BOT RANKED] ${human.username} vs ${bot.username}: Elo Atualizado`);

          socket.emit('elo_update', {
            newElo: human.elo,
            delta: humanDelta,
            rank: getRankName(human.elo)
          });
        } else {
          // Amistoso ou Minigame (Soma apenas para o humano, pois o bot pode não existir no banco)
          if (result === 'win' || result === 'victory') {
            human.wins++;
          } else {
            human.losses++;
          }
          console.log(`[BOT FRIENDLY/MINIGAME] ${human.username} vs Bot: Estatísticas mantidas.`);
        }

        await human.save();
        if (bot) {
          await bot.save();
        }

        // INCREMENTA ESTATÍSTICAS E MISSÕES AQUI (Passando true para isBot)
        await processPostMatchStats(myUserId, mode, result, true);
      }
    } catch (e) {
      console.error("Erro ao atualizar ranking contra bot:", e);
    }
  });

  // =================================================================
  // 6. GAME OVER BLINDADO (HUMANO VS HUMANO)
  // =================================================================
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;
    if (!rId || !activeMatches[rId]) return;

    const match = activeMatches[rId];

    if (match.isFinished) return;

    if (match.processingGameOver) return;
    match.processingGameOver = true;

    if (reconnectionTimeouts[rId]) {
      clearTimeout(reconnectionTimeouts[rId]);
      delete reconnectionTimeouts[rId];
    }

    console.log(`[GAME OVER] Sala ${rId} - Result: ${data.result}, Reason: ${data.reason}`);

    try {
      if (match.mode === 'ranked' && !match.eloCalculated) {
        match.eloCalculated = true;

        const p1Data = match.p1;
        const p2Data = match.p2;

        const user1 = await User.findOne({ userId: p1Data.id });
        const user2 = await User.findOne({ userId: p2Data.id });

        if (user1 && user2) {
          const isReporterP1 = (socket.user.id === p1Data.id);
          let winner, loser;
          let winnerScore = 0, loserScore = 0;

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

          const winnerEloBefore = winner.elo;
          const loserEloBefore = loser.elo;

          const realWinDelta = calculateEloDelta('win', data.reason, winnerScore, loserScore, winnerEloBefore, loserEloBefore);
          const finalWinPoints = Math.abs(realWinDelta) > 0 ? Math.abs(realWinDelta) : 10;
          const realLossDelta = calculateEloDelta('loss', data.reason, loserScore, winnerScore, loserEloBefore, winnerEloBefore);
          // INCREMENTA ESTATÍSTICAS E MISSÕES DOS DOIS JOGADORES AQUI
          const p1Result = (winner.userId === p1Data.id) ? 'win' : 'loss';
          const p2Result = (winner.userId === p2Data.id) ? 'win' : 'loss';
          await processPostMatchStats(p1Data.id, match.mode, p1Result);
          await processPostMatchStats(p2Data.id, match.mode, p2Result);
          console.log(`[ELO CALC] Winner (${winner.username}): +${finalWinPoints} | Loser (${loser.username}): ${realLossDelta}`);

          winner.elo += finalWinPoints;
          winner.wins++;
          loser.elo = Math.max(0, loser.elo + realLossDelta);
          loser.losses++;

          await Promise.all([winner.save(), loser.save()]);

          // INCREMENTA A MISSÃO DIÁRIA DOS DOIS JOGADORES AQUI
          await incrementDailyGame(p1Data.id);
          await incrementDailyGame(p2Data.id);

          setTimeout(() => {
            const s1 = onlineUsers[winner.userId];
            const s2 = onlineUsers[loser.userId];
            if (s1) io.to(s1).emit('elo_update', { newElo: winner.elo, delta: finalWinPoints, rank: getRankName(winner.elo) });
            if (s2) io.to(s2).emit('elo_update', { newElo: loser.elo, delta: realLossDelta, rank: getRankName(loser.elo) });
          }, 1500);
        }
      }
    } catch (e) {
      console.error("Erro Crítico no Elo:", e);
    }

    const reporterId = socket.user.id;
    const opponentId = (match.p1.id === reporterId) ? match.p2.id : match.p1.id;

    const resultNormalized = (data.result || '').toLowerCase();

    const isReporterWinner = ['win', 'victory', 'win_by_wo'].includes(resultNormalized);

    const finalWinnerId = isReporterWinner ? reporterId : opponentId;
    const finalLoserId = isReporterWinner ? opponentId : reporterId;

    io.to(rId).emit('game_message', {
      type: 'game_over',
      reason: data.reason,
      winnerId: finalWinnerId,
      loserId: finalLoserId,
      result: data.result
    });

    match.isFinished = true;

    if (cleanupTimeouts[rId]) clearTimeout(cleanupTimeouts[rId]);
    const isMinigame = ['thief_pvp', 'horse_race_pvp', 'tennis_pvp', 'king_pvp', 'queen_pvp'].includes(match.mode);

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
}); // <--- ESTA É A CHAVE QUE FALTAVA (Ela fecha o io.on('connection'))

// 🔴 CORRIGIDO: startMatch COM TUDO O QUE PRECISA
// 🔴 CORRIGIDO: startMatch COM FLAG DE HUMANO E ID DO OPONENTE
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

  // Payload Universal (Agora com isBot: false e ID do oponente)
  const p1Payload = {
    type: 'match_start',
    isPlayer1: true,
    opponent: {
      name: p2.user.name,
      elo: elo2,
      rank: getRankName(elo2),
      id: p2.user.id
    },
    mode: mode,
    mapSeed: (mode && mode.includes('horse')) ? mapSeed : 0,
    isBot: false
  };

  const p2Payload = {
    type: 'match_start',
    isPlayer1: false,
    opponent: {
      name: p1.user.name,
      elo: elo1,
      rank: getRankName(elo1),
      id: p1.user.id
    },
    mode: mode,
    mapSeed: (mode && mode.includes('horse')) ? mapSeed : 0,
    isBot: false
  };

  p1.emit('game_message', p1Payload);
  p2.emit('game_message', p2Payload);

  console.log(`[MATCH START] Sala ${roomId} criada. Modo: ${mode}. ${p1.user.name} vs ${p2.user.name}`);
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
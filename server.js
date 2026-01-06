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
  // [NOVO] Caixa de correio para quando estiver offline
  notifications: [{
    type: { type: String }, // Ex: 'friend_added_you'
    data: { type: Object }  // Ex: { name: 'Thiago' }
  }],
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ===========================================================================
// 2. ESTADO GLOBAL
// ===========================================================================
let queues = { ranked: [], friendly: [] };
const activeMatches = {};
const reconnectionTimeouts = {};
const cleanupTimeouts = {}; // [CORREÇÃO] Armazena os timers de limpeza para poder cancelar na revanche

// ===========================================================================
// 3. LÓGICA DE ELO (AJUSTADA PARA O NOVO SISTEMA DE HONRA)
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

  // --- 🟢 VITÓRIA (Pontuação Aumentada) ---
  if (res === 'win' || res === 'victory' || res === 'win_by_wo') {
    switch (rea) {
      case 'regicide': delta = 12; break;             // +12
      case 'dominance': delta = 10; break;            // +10
      case 'time_out': delta = 10; break;             // +10
      case 'annihilation': delta = 9; break;          // +9
      case 'surrender': delta = 9; break;             // +9
      case 'afk': delta = 9; break;                   // +9
      case 'opponent_disconnected': delta = 9; break; // +9
      default: delta = 6;
    }

    // Bônus de Desafio (Vencer alguém mais forte)
    if (oppElo > myElo) {
      const diffPercent = ((oppElo - myElo) / myElo) * 100;
      if (diffPercent >= 20) delta += 3;
      else if (diffPercent >= 15) delta += 1;
    }
    return delta;
  }

  // --- 🔴 DERROTA (Penalidades Ajustadas) ---
  else {
    // 1. Penalidades Fixas por Conduta (Sem choro, sem honra)
    if (rea === 'quit' || rea === 'opponent_disconnected') return -17;
    if (rea === 'afk') return -13;
    if (rea === 'surrender') return -11;

    // 2. Derrota em Combate (Regicídio, Tempo, Aniquilação sofridos)
    // Aqui entra o Sistema de Honra baseado no quanto o INIMIGO sobrou.
    let baseLoss = -9;
    let modifiers = 0;

    // oppScore = Pontos das peças que sobraram vivas no tabuleiro do vencedor.
    // Total Máximo Possível = 58.

    if (oppScore < 20) {
      // Inimigo sobrou com menos de 20 pontos (batalha sangrenta)
      modifiers += 4; // Perde só 5 (-9 + 4)
    } else if (oppScore >= 20 && oppScore <= 30) {
      modifiers += 3; // Perde só 6
    } else if (oppScore > 30 && oppScore <= 40) {
      modifiers += 2; // Perde só 7
    } else if (oppScore > 40 && oppScore <= 50) {
      modifiers += 1; // Perde só 8
    }
    // Se oppScore > 50 (Inimigo quase intacto), modifiers = 0. Perde 9 cheio.

    // Penalidade por Favoritismo (Perder para alguém muito mais fraco)
    if (myElo > oppElo) {
      const mmrDiff = ((myElo - oppElo) / myElo) * 100;
      if (mmrDiff >= 20) modifiers -= 2;      // Punição extra
      else if (mmrDiff >= 15) modifiers -= 1;
    }

    delta = baseLoss + modifiers;

    // Trava de segurança: Derrota nunca pode dar pontos positivos (mínimo 0)
    return delta > 0 ? 0 : delta;
  }
}

// ===========================================================================
// 4. MATCHMAKING (10% -> 30%)
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

      // --- NOVA LÓGICA: DE 10% ATÉ 30% ---
      const waitTime = (Date.now() - Math.min(p1.joinedAt, p2.joinedAt)) / 1000;

      // Começa em 10% e sobe 5% a cada 30 segundos
      let marginPercent = 10 + (Math.floor(waitTime / 30) * 5);

      // Trava o limite máximo em 30%
      if (marginPercent > 30) marginPercent = 30;

      const eloDiff = Math.abs(p1.user.elo - p2.user.elo);
      const avgElo = (p1.user.elo + p2.user.elo) / 2;
      const maxAllowedDiff = avgElo * (marginPercent / 100);

      // Só pareia se passar na regra estrita
      if (eloDiff <= maxAllowedDiff) {
        // Remove da fila
        queues[mode].splice(j, 1);
        queues[mode].splice(i, 1);

        startMatch(p1, p2, mode);

        // Reinicia o loop
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
    elo: 600 // Valor padrão (Será atualizado antes de entrar na fila)
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

  // --- RECONEXÃO BLINDADA ---
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return match && (match.p1.id === socket.user.id || match.p2.id === socket.user.id);
  });

  if (existingRoomId) {
    const match = activeMatches[existingRoomId];
    // Se a partida já acabou (isFinished), não reconecta na sala, apenas limpa
    if (match.isFinished) {
      // Pode emitir algo se quiser, mas geralmente não faz nada
    } else {
      console.log(`[RECONNECT] Usuário ${socket.user.name} voltou após oscilação.`);
      socket.roomId = existingRoomId;
      socket.join(existingRoomId);

      if (reconnectionTimeouts[existingRoomId]) {
        clearTimeout(reconnectionTimeouts[existingRoomId]);
        delete reconnectionTimeouts[existingRoomId];
      }

      // A MÁGICA: O servidor avisa os dois celulares para se sincronizarem agora!
      io.to(existingRoomId).emit('game_message', { type: 'force_full_sync_request' });
      socket.to(existingRoomId).emit('game_message', { type: 'opponent_reconnected' });
    }
  }

  // --- REGISTRO ---
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

      // [CORREÇÃO] Caixa de correio com DELAY para evitar perda de pacote no Flutter
      if (user.notifications && user.notifications.length > 0) {
        console.log(`[NOTIFY] Entregando ${user.notifications.length} pendências para ${user.username}`);

        // Espera 2 segundos para o Flutter carregar a Home Screen
        setTimeout(async () => {
          // Envia as notificações que estavam na memória
          for (const notif of user.notifications) {
            socket.emit(notif.type, notif.data);
          }

          // Limpeza Cirúrgica: Limpa só o array de notificações no banco, sem mexer no resto do user
          await User.updateOne({ userId: user.userId }, { $set: { notifications: [] } });
        }, 7000);
      }

      // Atualiza o socket na memória
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
      if (target.userId === socket.user.id) return socket.emit('friend_error', 'Você não pode adicionar a si mesmo.');

      const me = await User.findOne({ userId: socket.user.id });
      if (!me) return;

      if (me.friends.length >= 20) return socket.emit('friend_error', 'Limite de 20 amigos atingido!');
      if (me.friends.includes(target.userId)) return socket.emit('friend_error', 'Já é seu amigo.');

      me.friends.push(target.userId);
      await me.save();
      socket.emit('friend_success', `Agora você segue ${target.username}!`);

      const targetSocketId = onlineUsers[target.userId];
      const notificationData = { name: socket.user.name };

      if (targetSocketId) {
        // CENÁRIO 1: ONLINE (Entrega Imediata)
        io.to(targetSocketId).emit('friend_added_you', notificationData);
      } else {
        // CENÁRIO 2: OFFLINE (Guarda na Caixa de Correio)
        console.log(`[OFFLINE] Guardando notificação para ${target.username}`);
        target.notifications.push({
          type: 'friend_added_you',
          data: notificationData
        });
        await target.save();
      }

    } catch (e) { console.error(e); }
  });

  // --- [CORREÇÃO] LISTA DE AMIGOS COM RANKING ---
  socket.on('get_friends_list', async () => {
    try {
      const me = await User.findOne({ userId: socket.user.id });
      if (!me || !me.friends) return socket.emit('friends_list_data', []);

      // Agora ordena por Elo decrescente (-1)
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
      socket.emit('friend_error', 'Amigo está offline ou em batalha.');
    }
  });

  socket.on('accept_invite', (inviterId) => {
    const inviterSocketId = onlineUsers[inviterId];
    if (inviterSocketId) {
      const inviterSocket = io.sockets.sockets.get(inviterSocketId);
      if (inviterSocket) {
        queues.ranked = queues.ranked.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);
        queues.friendly = queues.friendly.filter(s => s.id !== socket.id && s.id !== inviterSocket.id);
        startMatch(inviterSocket, socket, 'friendly');
      } else {
        socket.emit('friend_error', 'Convite expirou.');
      }
    }
  });

  // =================================================================
  // [CORREÇÃO] LEADERBOARD (RANKING MUNDIAL)
  // =================================================================
  socket.on('get_leaderboard', async () => {
    try {
      // 1. Verificação de segurança: O banco está conectado?
      if (mongoose.connection.readyState !== 1) {
        console.error("⚠️ MongoDB não está conectado (ReadyState !== 1)");
        throw new Error("Banco de dados desconectado/instável.");
      }

      // 2. Busca os Top 100 ordenados por Elo (Maior para menor)
      // .lean() faz a consulta ser muito mais rápida pois retorna JSON puro
      const top100 = await User.find({})
        .sort({ elo: -1 })
        .limit(100)
        .select('username elo userId')
        .lean();

      // 3. Descobre a posição do usuário que solicitou
      // Se o socket não tiver ID, usa um dummy para não quebrar
      const currentUserId = socket.user ? socket.user.id : "visitor";
      const myUser = await User.findOne({ userId: currentUserId }).select('username elo').lean();

      let myRank = 0;
      let myElo = 600;
      let myName = socket.user ? socket.user.name : "Guerreiro";

      if (myUser) {
        myElo = myUser.elo;
        myName = myUser.username;
        // Conta quantos jogadores têm Elo MAIOR que o meu
        const countAbove = await User.countDocuments({ elo: { $gt: myElo } });
        myRank = countAbove + 1;
      }

      console.log(`[LEADERBOARD] Enviando ${top100.length} jogadores para ${myName}`);

      // 4. Envia os dados (SUCESSO)
      socket.emit('leaderboard_data', {
        top100: top100.map(u => ({
          name: u.username,
          elo: u.elo,
          id: u.userId
        })),
        myRank: myRank,
        myElo: myElo,
        myName: myName
      });

    } catch (e) {
      console.error("❌ Erro CRÍTICO no Leaderboard:", e.message);

      // [MUITO IMPORTANTE] 
      // Se der erro, enviamos uma lista vazia com os dados de fallback.
      // Isso faz o 'loading' do Flutter sumir e mostrar a lista vazia, em vez de travar.
      socket.emit('leaderboard_data', {
        top100: [],
        myRank: 0,
        myElo: socket.user ? socket.user.elo : 600,
        myName: socket.user ? socket.user.name : "Guerreiro"
      });
    }
  });

  // --- MATCHMAKING (COM ATUALIZAÇÃO FORÇADA DE ELO) ---
  // --- MATCHMAKING BLINDADO (SEM FURAR FILA) ---
  socket.on('find_match', async (incomingData) => { // Async obrigatório

    // 1. GUARDIÃO DA FILA (A CORREÇÃO DO ESPERTINHO)
    // Varre todas as partidas ativas na memória.
    // Se o usuário (pelo ID, não pelo socket) já estiver jogando, BLOQUEIA.
    const ongoingMatchId = Object.keys(activeMatches).find(roomId => {
      const m = activeMatches[roomId];
      // Verifica se é um dos jogadores E se a partida não acabou
      return (m.p1.id === socket.user.id || m.p2.id === socket.user.id) && !m.isFinished;
    });

    if (ongoingMatchId) {
      console.log(`[BLOCK] ${socket.user.name} tentou entrar na fila mas já está na sala ${ongoingMatchId}.`);

      // Avisa o cliente que ele não pode jogar
      socket.emit('match_error', 'Você ainda tem uma batalha em andamento!');

      // (Opcional) Força o cliente a voltar para a sala antiga
      // socket.emit('force_rejoin', { roomId: ongoingMatchId }); 
      return;
    }

    // -----------------------------------------------------------

    const mode = (incomingData?.mode?.toLowerCase() === 'friendly') ? 'friendly' : 'ranked';

    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (mode === 'friendly') {
      const opponent = queues.friendly.shift();
      if (opponent) startMatch(opponent, socket, 'friendly');
      else queues.friendly.push(socket);
    } else {
      // --- ATUALIZAÇÃO DE ELO NA FILA ---
      try {
        const user = await User.findOne({ userId: socket.user.id });
        if (user) {
          socket.user.elo = user.elo;
          socket.user.name = user.username;
          console.log(`[QUEUE] ${user.username} entrando com Elo ATUALIZADO: ${user.elo}`);
        }
      } catch (err) { console.error("Erro ao atualizar Elo na fila:", err); }

      socket.joinedAt = Date.now();
      queues.ranked.push(socket);

      // Chama a lógica dinâmica
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

        // --- [NOVO] ATUALIZA O TURNO SE O CLIENTE DISSE QUE ACABOU ---
        if (msg.turnEnded === true) {
          match.isPlayer1Turn = !match.isPlayer1Turn;
        }
        // -------------------------------------------------------------

        socket.to(rId).emit('game_message', msg);
      }
    }
  });

  // --- [NOVO] ATUALIZAÇÃO DE TURNO NO SERVIDOR (TURN_PASS EXPLÍCITO) ---
  socket.on('turn_pass', (data) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      // Inverte o turno no servidor
      activeMatches[rId].isPlayer1Turn = !activeMatches[rId].isPlayer1Turn;

      // Repassa para o oponente
      socket.to(rId).emit('game_message', {
        type: 'turn_pass',
        p1Time: data.p1Time,
        p2Time: data.p2Time
      });
    }
  });

  // --- [NOVO] O "DOUTOR DE TURNO" (CORREÇÃO AUTOMÁTICA DE DEADLOCK) ---
  socket.on('check_turn_integrity', (clientThinkIsP1) => {
    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      const serverThinkIsP1 = activeMatches[rId].isPlayer1Turn;

      // Se o cliente discorda do servidor sobre de quem é a vez
      if (clientThinkIsP1 !== serverThinkIsP1) {
        console.log(`[FIX] Desincronia de turno detectada na sala ${rId}. Forçando Sync.`);
        // Força AMBOS a ressincronizarem para garantir
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

        // [CORREÇÃO] CANCELA A LIMPEZA AUTOMÁTICA DA SALA
        // Isso impede que o servidor apague a sala no meio da revanche!
        if (cleanupTimeouts[rId]) {
          clearTimeout(cleanupTimeouts[rId]);
          delete cleanupTimeouts[rId];
          console.log(`[REMATCH] Timer de limpeza cancelado para sala ${rId}`);
        }

        const match = activeMatches[rId];
        match.moveHistory = [];
        match.p1Time = 1020;
        match.p2Time = 1020;
        match.isPlayer1Turn = true; // [NOVO] Reseta turno para P1
        match.isFinished = false; // [IMPORTANTE] Reseta a trava para o novo jogo
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

  // =================================================================
  // 6. GAME OVER BLINDADO (CORREÇÃO DE PONTUAÇÃO DUPLICADA)
  // =================================================================
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;

    // 1. Verificação básica
    if (!rId || !activeMatches[rId]) return;

    const match = activeMatches[rId];

    // 🔴 TRAVA DE SEGURANÇA (O SEGREDO)
    // Se a partida já foi marcada como finalizada, ignora qualquer pacote atrasado
    if (match.isFinished) {
      console.log(`[GAME OVER] Ignorando report duplicado da sala ${rId}`);
      return;
    }

    // Marca imediatamente como finalizada na memória
    match.isFinished = true;

    // 2. CANCELA O TIMER DE DESCONEXÃO (SE HOUVER)
    // Isso impede que, se o jogo acabar enquanto alguém estava "caído", dê WO.
    if (reconnectionTimeouts[rId]) {
      console.log(`[GAME OVER] Cancelando timer de desconexão da sala ${rId}.`);
      clearTimeout(reconnectionTimeouts[rId]);
      delete reconnectionTimeouts[rId];
    }

    console.log(`[GAME OVER] Sala ${rId} - Result: ${data.result}, Reason: ${data.reason}`);

    try {
      // Verifica se é RANKEADA para calcular Elo
      // Verifica se é RANKEADA para calcular Elo
      if (match.mode === 'ranked') {
        // Busca AMBOS os usuários para garantir a atualização única e atômica
        const p1Data = match.p1;
        const p2Data = match.p2;

        const user1 = await User.findOne({ userId: p1Data.id });
        const user2 = await User.findOne({ userId: p2Data.id });

        if (user1 && user2) {
          // Lógica para determinar quem é Vencedor e quem é Perdedor E AS PONTUAÇÕES REAIS
          const isReporterP1 = (socket.user.id === p1Data.id);
          let winner, loser;
          let winnerScore = 0, loserScore = 0; // [CORREÇÃO] Variáveis para guardar score real

          // Se o report diz que quem enviou GANHOU:
          if (['win', 'victory'].includes(data.result?.toLowerCase())) {
            if (isReporterP1) {
              winner = user1; loser = user2;
              winnerScore = data.myScore || 0; loserScore = data.oppScore || 0;
            } else {
              winner = user2; loser = user1;
              winnerScore = data.oppScore || 0; loserScore = data.myScore || 0;
            }
          }
          // Se o report diz que quem enviou PERDEU:
          else {
            if (isReporterP1) {
              winner = user2; loser = user1;
              winnerScore = data.oppScore || 0; loserScore = data.myScore || 0;
            } else {
              winner = user1; loser = user2;
              winnerScore = data.myScore || 0; loserScore = data.oppScore || 0;
            }
          }

          const winnerEloBefore = winner.elo;
          const loserEloBefore = loser.elo;

          // 2. Cálculo do Vencedor (Passando os scores reais capturados acima)
          // Nota: Para o vencedor, myScore = winnerScore, oppScore = loserScore
          const realWinDelta = calculateEloDelta('win', data.reason, winnerScore, loserScore, winnerEloBefore, loserEloBefore);
          const finalWinPoints = Math.abs(realWinDelta) > 0 ? Math.abs(realWinDelta) : 10;

          // 3. Cálculo do Perdedor (Passando os scores reais capturados acima)
          // Nota: Para o perdedor, myScore = loserScore, oppScore = winnerScore
          let realLossDelta = calculateEloDelta('loss', data.reason, loserScore, winnerScore, loserEloBefore, winnerEloBefore);

          // [CORREÇÃO CRÍTICA] Evita o bug do "loading eterno".
          // Se a matemática der 0 (ex: perdeu pra alguém muito forte e matou muito), força -1.
          if (realLossDelta === 0) realLossDelta = -1;

          // Aplica mudanças no Banco
          winner.elo += finalWinPoints;
          winner.wins++;

          loser.elo = Math.max(0, loser.elo + realLossDelta);
          loser.losses++;

          await winner.save();
          await loser.save();

          console.log(`[ELO] ${winner.username} (+${finalWinPoints}) vs ${loser.username} (${realLossDelta})`);

          // Envia updates para os sockets conectados em tempo real
          const s1 = onlineUsers[winner.userId];
          const s2 = onlineUsers[loser.userId];

          if (s1) io.to(s1).emit('elo_update', { newElo: winner.elo, delta: finalWinPoints, rank: getRankName(winner.elo) });
          if (s2) io.to(s2).emit('elo_update', { newElo: loser.elo, delta: realLossDelta, rank: getRankName(loser.elo) });
        }
      }
    } catch (e) { console.error("Erro Elo Report:", e); }

    // Envia mensagem final para a sala (Game Over Visual)
    io.to(rId).emit('game_message', {
      type: 'game_over',
      reason: data.reason,
      result: data.result,
      winnerId: socket.user.id // Quem mandou o report de vitória
    });

    // 🔴 LIMPEZA FINAL DA MEMÓRIA
    // Aumentado para 30 segundos para permitir Revanche
    // Guardamos o timer no objeto global para poder cancelar na Revanche
    if (cleanupTimeouts[rId]) clearTimeout(cleanupTimeouts[rId]);

    cleanupTimeouts[rId] = setTimeout(() => {
      if (activeMatches[rId]) {
        delete activeMatches[rId];
        delete cleanupTimeouts[rId];
        console.log(`[CLEANUP] Sala ${rId} removida com sucesso após 30s.`);
      }
    }, 30000); // 30 Segundos
  });

  // =================================================================
  // 7. DESCONEXÃO BLINDADA (IGNORA FANTASMAS)
  // =================================================================
  socket.on('disconnect', async () => {
    // 1. VERIFICAÇÃO DE FANTASMA (CRUCIAL!)
    const currentSocketId = onlineUsers[socket.user.id];
    if (currentSocketId && currentSocketId !== socket.id) {
      console.log(`[IGNORE] Desconexão ignorada para ${socket.user.name} (Socket velho caindo, novo já ativo).`);
      return;
    }

    if (onlineUsers[socket.user.id] === socket.id) {
      delete onlineUsers[socket.user.id];
    }

    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const rId = socket.roomId;

    // Se estava em partida E a partida NÃO acabou ainda...
    if (rId && activeMatches[rId] && !activeMatches[rId].isFinished) {
      console.log(`[DISCONNECT] ${socket.user.name} caiu da sala ${rId}. Iniciando timer de 25s...`);

      // Avisa o oponente que o cara caiu (para mostrar "Aguardando..." na tela)
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      // ⏳ O TIMER DE TOLERÂNCIA (Aqui evita a derrota na micro-queda)
      reconnectionTimeouts[rId] = setTimeout(async () => {

        // Checa se a partida ainda existe e se não foi finalizada nesse meio tempo
        if (activeMatches[rId]) {

          // Se a partida JÁ ACABOU (isFinished), cancela tudo.
          if (activeMatches[rId].isFinished) return;

          // Verifica se o usuário voltou (está na lista de onlineUsers com novo socket?)
          const isUserBack = onlineUsers[socket.user.id];

          if (!isUserBack) {
            // AGORA SIM: Passaram 25s e ele não voltou. É derrota.
            console.log(`[TIMEOUT] ${socket.user.name} não voltou. Declarando WO.`);

            const match = activeMatches[rId];
            match.isFinished = true; // Ativa a trava agora

            // Avisa o oponente que ele ganhou por WO
            io.to(rId).emit('game_message', {
              type: 'game_over',
              reason: 'opponent_disconnected',
              result: 'win_by_wo'
            });

            // Lógica de punição por WO (Ranked)
            if (match.mode === 'ranked') {
              try {
                const quitter = await User.findOne({ userId: socket.user.id });
                const winnerId = (match.p1.id === socket.user.id) ? match.p2.id : match.p1.id;
                const winner = await User.findOne({ userId: winnerId });

                if (quitter && winner) {
                  // Punição fixa de -17 por quitar
                  quitter.elo = Math.max(0, quitter.elo - 17);
                  quitter.losses++;
                  await quitter.save();

                  // Vencedor ganha pontos (cálculo normal de vitória)
                  const delta = calculateEloDelta('win', 'opponent_disconnected', 0, 0, winner.elo, quitter.elo);
                  const finalWinPoints = Math.abs(delta) > 0 ? Math.abs(delta) : 10;
                  winner.elo += finalWinPoints;
                  winner.wins++;
                  await winner.save();

                  // Tenta avisar o vencedor do novo Elo (se estiver online)
                  const sWinner = onlineUsers[winner.userId];
                  if (sWinner) io.to(sWinner).emit('elo_update', { newElo: winner.elo, delta: finalWinPoints, rank: getRankName(winner.elo) });
                }
              } catch (e) { console.error("Erro WO:", e); }
            }

            // Limpeza final
            delete activeMatches[rId];
            delete reconnectionTimeouts[rId];
          } else {
            console.log(`[TIMEOUT] Cancelado. Usuário ${socket.user.name} já voltou.`);
          }
        }
      }, 25000); // 25 segundos
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
    mode,
    moveHistory: [],
    p1Time: 1020,
    p2Time: 1020,
    isPlayer1Turn: true, // [NOVO] Controle de turno no servidor
    isFinished: false    // [NOVO] Trava de segurança para Game Over
  };

  p1.emit('match_found', { isPlayer1: true, opponent: { name: p2.user.name, elo: elo2, rank: getRankName(elo2) }, mode });
  p2.emit('match_found', { isPlayer1: false, opponent: { name: p1.user.name, elo: elo1, rank: getRankName(elo1) }, mode });
}

server.listen(process.env.PORT || 8080, () => console.log(`Servidor Ativo`));
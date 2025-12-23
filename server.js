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
// 3. LÓGICA DE ELO (ATUALIZADA)
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

  // VERIFICAÇÃO DE VITÓRIA
  if (result === 'win' || result === 'win_by_wo') {
    switch (reason) {
      case 'regicide': delta = 10; break;
      case 'dominance': delta = 9; break;
      case 'annihilation': delta = 8; break;
      case 'surrender': delta = 7; break;
      case 'afk': delta = 7; break;
      case 'opponent_disconnected': delta = 7; break;
      case 'time_out': delta = 9; break;
      default: delta = 0; // Removido padrão 5 por segurança (aguarda motivo)
    }

    // Bônus Davi vs Golias (Verificação de porcentagem corrigida)
    if (oppElo > myElo) {
      const diffPercent = ((oppElo - myElo) / myElo) * 100;
      if (diffPercent >= 20) {
        delta += 3;
      } else if (diffPercent >= 15) {
        delta += 1;
      }
    }
  }
  // VERIFICAÇÃO DE DERROTA OU DESISTÊNCIA PRÓPRIA
  else {
    // Penalidades fixas por abandono (Bug de perder pontos no surrender corrigido aqui)
    if (reason === 'quit' || reason === 'opponent_disconnected') return -17;
    if (reason === 'afk') return -10;
    if (reason === 'surrender') return -10;

    let baseLoss = -8;
    let modifiers = 0;

    // Redução de perda por performance
    if (oppScore > 0 && myScore > 0) {
      const perfDiff = ((oppScore - myScore) / myScore) * 100;
      if (perfDiff < 50) modifiers += 4;
      else if (perfDiff < 80) modifiers += 3;
      else if (perfDiff < 100) modifiers += 2;
      else if (perfDiff < 150) modifiers += 1;
    } else if (myScore > 0 && oppScore === 0) {
      modifiers += 4;
    }

    // Penalidade maior se você era o favorito e perdeu
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
// 4. LÓGICA DE MATCHMAKING DINÂMICO
// ===========================================================================

function findMatchDynamic() {
  const mode = 'ranked';
  const queue = queues[mode];
  if (queue.length < 2) return;

  // Percorre a fila tentando parear jogadores
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const p1 = queue[i];
      const p2 = queue[j];

      if (p1.user.id === p2.user.id) continue;

      // Tempo de espera do mais antigo entre os dois
      const waitTime = (Date.now() - Math.min(p1.joinedAt, p2.joinedAt)) / 1000;

      // Lógica de expansão: 5% base + 5% a cada 30s. Máximo 30%.
      let marginPercent = 5 + (Math.floor(waitTime / 30) * 5);
      if (marginPercent > 30) marginPercent = 30;

      const eloDiff = Math.abs(p1.user.elo - p2.user.elo);
      const avgElo = (p1.user.elo + p2.user.elo) / 2;
      const maxAllowedDiff = avgElo * (marginPercent / 100);

      if (eloDiff <= maxAllowedDiff) {
        // Remove da fila e inicia
        queues[mode].splice(j, 1);
        queues[mode].splice(i, 1);
        startMatch(p1, p2, mode);
        return findMatchDynamic(); // Tenta parear o próximo da fila
      }
    }
  }
}

// Loop de verificação do Matchmaking (Roda a cada 5 segundos)
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

  // --- MATCHMAKING ---
  socket.on('find_match', (incomingData) => {
    const mode = (incomingData?.mode?.toLowerCase() === 'friendly') ? 'friendly' : 'ranked';

    // Remove se já estiver em alguma fila
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    if (mode === 'friendly') {
      const opponent = queues.friendly.shift();
      if (opponent) startMatch(opponent, socket, 'friendly');
      else queues.friendly.push(socket);
    } else {
      socket.joinedAt = Date.now(); // Importante para a expansão do Elo
      queues.ranked.push(socket);
      findMatchDynamic(); // Tenta parear imediatamente
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
      const match = activeMatches[rId];
      match.moveHistory.push(msg);
      socket.to(rId).emit('game_message', msg);
    }
  });

  socket.on('provide_game_state', (data) => {
    if (socket.roomId) socket.to(socket.roomId).emit('sync_game_state', data);
  });

  // --- GAME OVER ---
  socket.on('game_over_report', async (data) => {
    const rId = socket.roomId;
    if (!rId || !activeMatches[rId]) return;
    const match = activeMatches[rId];

    try {
      const user = await User.findOne({ userId: socket.user.id });
      if (user && match.mode === 'ranked') {
        const isP1 = match.p1.id === socket.user.id;
        const myStartElo = isP1 ? match.p1.elo : match.p2.elo;
        const oppStartElo = isP1 ? match.p2.elo : match.p1.elo;

        const delta = calculateEloDelta(data.result, data.reason, data.myScore || 0, data.oppScore || 0, myStartElo, oppStartElo);

        let newElo = Math.max(0, user.elo + delta);
        user.elo = newElo;
        if (data.result === 'win') user.wins++; else user.losses++;
        await user.save();

        socket.emit('elo_update', { newElo, delta, rank: getRankName(newElo) });
      }
    } catch (e) { console.error("Erro Elo Report:", e); }

    socket.to(rId).emit('game_message', { type: 'game_over', report_data: data });
  });

  socket.on('disconnect', async () => {
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const rId = socket.roomId;
    if (rId && activeMatches[rId]) {
      socket.to(rId).emit('game_message', { type: 'opponent_disconnected' });

      reconnectionTimeouts[rId] = setTimeout(async () => {
        if (activeMatches[rId]) {
          const match = activeMatches[rId];
          io.to(rId).emit('game_message', { type: 'game_over', reason: 'opponent_disconnected', result: 'win_by_wo' });

          if (match.mode === 'ranked') {
            try {
              const quitter = await User.findOne({ userId: socket.user.id });
              if (quitter) {
                quitter.elo = Math.max(0, quitter.elo - 17);
                quitter.losses++;
                await quitter.save();
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
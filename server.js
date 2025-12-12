// server.js (Node.js)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Permite conexões de qualquer lugar (importante para Web/Flutter Web futuro)
    methods: ["GET", "POST"]
  }
});

// --- ESTADO EM MEMÓRIA (Em produção, usar Redis/Mongo) ---
let rankedQueue = []; // Fila de espera para Ranked
const activeMatches = {}; // Mapa de salaID -> { p1, p2, gameState... }

io.use((socket, next) => {
  // MIDDLEWARE DE AUTENTICAÇÃO (Roadmap #2 e #3)
  const auth = socket.handshake.auth || {};
  const { userId, name, token, skins, version } = auth;

  // 1. Validar versão do app (Obrigatório para jogos online)
  if (version !== '1.0.0') {
    // Você pode ser mais flexível aqui durante o desenvolvimento
    // return next(new Error("Por favor, atualize o jogo."));
    console.log(`Aviso: Cliente ${name} usando versão ${version}`);
  }

  // Salvar dados na sessão do socket
  socket.user = {
    id: userId || uuidv4(),
    name: name || 'Guerreiro',
    skins: skins || {},
    elo: 1200 // Virá do Banco de Dados futuramente
  };

  next();
});

io.on('connection', (socket) => {
  console.log(`Jogador conectado: ${socket.user.name} (${socket.id})`);

  // --- MATCHMAKING ---
  socket.on('find_match', (data) => {
    const mode = data.mode; // 'ranked' ou 'casual'

    if (mode === 'ranked') {
      // Tenta achar alguém na fila
      if (rankedQueue.length > 0) {
        const opponent = rankedQueue.shift();

        // Evita jogar contra si mesmo (se abrir 2 abas ou reconectar rápido)
        if (opponent.id === socket.id) {
          rankedQueue.push(opponent);
          return;
        }

        // Verifica se o oponente ainda está conectado antes de iniciar
        if (opponent.connected) {
          startMatch(opponent, socket, 'ranked');
        } else {
          // Oponente caiu da fila, tenta o próximo (se houver) ou entra na fila
          // Aqui simplificamos: entra na fila
          rankedQueue.push(socket);
          socket.emit('status', 'Oponente desconectou. Na fila de espera...');
        }
      } else {
        rankedQueue.push(socket);
        socket.emit('status', 'Na fila de espera...');
      }
    }
  });

  socket.on('leave_queue', () => {
    rankedQueue = rankedQueue.filter(s => s.id !== socket.id);
  });

  // --- GAMEPLAY ---
  socket.on('game_move', (msg) => {
    // O socket precisa saber em qual sala está
    const roomId = socket.roomId;
    if (!roomId) return;

    // Repassa a jogada para o oponente na mesma sala
    socket.to(roomId).emit('game_message', msg);
  });

  // --- FIM DE JOGO E RANKING ---
  socket.on('game_over_report', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !activeMatches[roomId]) return;

    const match = activeMatches[roomId];

    // Lógica simples de segurança: Só processa se não processou ainda
    if (match.processed) return;
    match.processed = true;

    console.log(`Fim de jogo na sala ${roomId}. Resultado: ${data.result}`);

    // Limpeza
    delete activeMatches[roomId];
  });

  socket.on('disconnect', () => {
    console.log(`Jogador desconectou: ${socket.user.name}`);
    // Remove da fila
    rankedQueue = rankedQueue.filter(s => s.id !== socket.id);

    // Avisa oponente se estiver em jogo
    if (socket.roomId) {
      socket.to(socket.roomId).emit('opponent_disconnected');
      delete activeMatches[socket.roomId];
    }
  });
});

function startMatch(p1, p2, mode) {
  const roomId = uuidv4();

  // Associa sockets à sala
  p1.join(roomId);
  p2.join(roomId);
  p1.roomId = roomId;
  p2.roomId = roomId;

  // Salva estado da partida
  activeMatches[roomId] = {
    p1: p1.user,
    p2: p2.user,
    startTime: Date.now(),
    mode: mode,
    processed: false
  };

  // Avisa P1 (É o Jogador 1 / Branco / Azul)
  p1.emit('match_found', {
    isPlayer1: true,
    opponent: { name: p2.user.name, skins: p2.user.skins, elo: p2.user.elo }
  });

  // Avisa P2 (É o Jogador 2 / Preto / Vermelho)
  p2.emit('match_found', {
    isPlayer1: false,
    opponent: { name: p1.user.name, skins: p1.user.skins, elo: p1.user.elo }
  });

  console.log(`Partida iniciada: ${p1.user.name} vs ${p2.user.name}`);
}

// CORREÇÃO CRÍTICA AQUI EMBAIXO:
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor BoardWar rodando na porta ${PORT}`);
});
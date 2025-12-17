// server.js
// (VERSÃO CORRIGIDA: FILAS BLINDADAS + PARSE SEGURO + ECO DO MODO)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Permite conexões de qualquer lugar (App/Web)
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Espera até 60s sem resposta antes de considerar "caiu"
  pingInterval: 25000 // Envia um ping a cada 25s para manter conexão
});

// --- ESTADO EM MEMÓRIA ---
// AGORA SEPARAMOS AS FILAS
let queues = {
  ranked: [],
  friendly: []
};

const activeMatches = {}; // Mapa de salaID -> dados da partida

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const { userId, name, skins, version } = auth;

  // Validação simples de versão
  if (version && version !== '1.0.0') {
    console.log(`Aviso: Cliente ${name} versão diferente (${version})`);
  }

  // Identidade do socket
  socket.user = {
    id: userId || uuidv4(),
    name: name || 'Guerreiro',
    skins: skins || {},
    elo: 1200
  };

  next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  console.log(`[CONNECT] ${socket.user.name} (${userId})`);

  // --- LÓGICA DE RECONEXÃO (SISTEMA "IMORTAL") ---
  // Verifica se este usuário já tem uma sala ativa na memória
  const existingRoomId = Object.keys(activeMatches).find(roomId => {
    const match = activeMatches[roomId];
    return (match.p1.id === userId || match.p2.id === userId);
  });

  if (existingRoomId) {
    console.log(`[REJOIN] ${socket.user.name} voltou para sala ${existingRoomId}`);
    const match = activeMatches[existingRoomId];

    // 1. Cancela a limpeza de memória de segurança (Garbage Collector)
    if (match.gcTimeout) {
      clearTimeout(match.gcTimeout);
      delete match.gcTimeout;
    }

    // 2. Reconecta o socket à sala
    socket.join(existingRoomId);
    socket.roomId = existingRoomId;

    // 3. Avisa o oponente que o jogador voltou
    socket.to(existingRoomId).emit('status', `${socket.user.name} voltou para o jogo!`);

    // 4. Descobre quem ele era (P1 ou P2)
    const isP1 = (match.p1.id === userId);
    const opponentData = isP1 ? match.p2 : match.p1;

    // 5. Envia sucesso, histórico E O MODO (para corrigir o título no app)
    socket.emit('rejoin_success', {
      isPlayer1: isP1,
      opponent: opponentData,
      history: match.moveHistory, // Garante que as peças voltem pro lugar
      mode: match.mode // <--- IMPORTANTE: Devolve o modo para o App saber qual título mostrar
    });

    return; // Encerra aqui para não entrar na fila de matchmaking
  }

  // --- MATCHMAKING COM SEPARAÇÃO DE FILAS (CORRIGIDO) ---
  socket.on('find_match', (raw_data) => {
    // BLINDAGEM: Se o Dart enviar como string JSON, convertemos para objeto
    // Isso evita o erro onde o modo "friendly" era ignorado
    let data = raw_data;
    if (typeof raw_data === 'string') {
      try {
        data = JSON.parse(raw_data);
      } catch (e) {
        data = {};
      }
    }

    // Garante que o modo seja string e minúsculo
    let mode = (data && data.mode) ? data.mode.toString().toLowerCase() : 'ranked';

    console.log(`[SEARCH] ${socket.user.name} busca: ${mode.toUpperCase()}`);

    // Segurança: só aceita modos válidos
    if (mode !== 'ranked' && mode !== 'friendly') {
      console.log(`[ERROR] Modo inválido recebido: ${mode} -> Forçando RANKED`);
      mode = 'ranked';
    }

    // 1. REMOVE O USUÁRIO DE TODAS AS FILAS
    // Isso é vital. Se ele clicou em Ranked e depois mudou pra Friendly,
    // ele precisa sair da fila Ranked primeiro.
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    const currentQueue = queues[mode];

    if (currentQueue.length > 0) {
      // Tenta pegar o primeiro da fila DO MODO CORRETO
      let opponent = currentQueue.shift();

      // Evita jogar contra si mesmo (loop de teste)
      if (opponent.user.id === socket.user.id) {
        currentQueue.push(opponent);
        return;
      }

      // Verifica se oponente ainda está com conexão ativa
      if (opponent.connected) {
        startMatch(opponent, socket, mode);
      } else {
        // Se o da fila caiu, tenta o próximo ou coloca este na fila
        currentQueue.push(socket);
        socket.emit('status', 'Oponente da fila caiu. Aguardando...');
      }
    } else {
      // Fila vazia, entra nela
      currentQueue.push(socket);

      if (mode === 'ranked') {
        socket.emit('status', 'Buscando Ranqueada (Hardcore)...');
      } else {
        socket.emit('status', 'Buscando Amistoso (Casual)...');
      }
    }
  });

  socket.on('leave_queue', () => {
    // Remove de ambas as filas para garantir limpeza total
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);
    console.log(`[LEAVE] ${socket.user.name} saiu da fila.`);
  });

  // --- GAMEPLAY ---
  socket.on('game_move', (msg) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    // Salva o movimento no histórico da sala (ESSENCIAL PARA RECONEXÃO)
    if (activeMatches[roomId]) {
      activeMatches[roomId].moveHistory.push(msg);
    }

    // Repassa TUDO para o oponente
    socket.to(roomId).emit('game_message', msg);
  });

  // --- FIM DE JOGO ---
  socket.on('game_over_report', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !activeMatches[roomId]) return;

    console.log(`[GAME OVER] Sala ${roomId}. Resultado: ${data.result}`);

    // Jogo acabou oficialmente, pode deletar a sala
    delete activeMatches[roomId];
  });

  // --- DESCONEXÃO (SISTEMA "IMORTAL") ---
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.user.name}`);

    // 1. Remove de QUALQUER fila que esteja
    queues.ranked = queues.ranked.filter(s => s.id !== socket.id);
    queues.friendly = queues.friendly.filter(s => s.id !== socket.id);

    // 2. Se estava em jogo, APENAS AVISA. Não destrói a sala imediatamente.
    if (socket.roomId && activeMatches[socket.roomId]) {
      const rId = socket.roomId;

      // Avisa o oponente
      socket.to(rId).emit('status', 'Oponente desconectou. Aguardando retorno...');
      socket.to(rId).emit('opponent_disconnected'); // Avisa UI para pausar/alertar

      // Garbage Collector de segurança (15 min)
      if (!activeMatches[rId].gcTimeout) {
        activeMatches[rId].gcTimeout = setTimeout(() => {
          if (activeMatches[rId]) {
            console.log(`[GC] Sala ${rId} inativa por 15min. Limpando memória.`);
            // Se ainda existir alguém conectado lá, avisa Game Over por WO
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
    mode: mode, // SALVA O MODO (Ranked/Friendly) - CRUCIAL
    moveHistory: []
  };

  // Avisa P1
  p1.emit('match_found', {
    isPlayer1: true,
    opponent: { name: p2.user.name, skins: p2.user.skins, elo: p2.user.elo },
    mode: mode // Devolve o modo confirmado para o App ajustar o título
  });

  // Avisa P2
  p2.emit('match_found', {
    isPlayer1: false,
    opponent: { name: p1.user.name, skins: p1.user.skins, elo: p1.user.elo },
    mode: mode // Devolve o modo confirmado para o App ajustar o título
  });

  console.log(`[START] Match ${mode.toUpperCase()}: ${p1.user.name} vs ${p2.user.name} (Sala ${roomId})`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor BoardWar rodando na porta ${PORT}`);
});
require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ===================== Supabase =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===================== App initialisation =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===================== In‑memory user cache =====================
const users = {};   // telegramId -> { id, username, balance }

async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', id)
    .maybeSingle();

  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 1000 };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 1000 };
  }
  return users[id];
}

// ===================== Telegram verification =====================
function verifyTelegram(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return calculatedHash === hash;
}

// ===================== Auth endpoint =====================
app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) return res.status(403).json({ success: false });

  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);
  const user = await loadUser(id, userData.first_name || userData.username);
  req.session.userId = id;

  res.json({ success: true, userId: id, username: user.username, balance: user.balance });
});

// ===================== Admin add balance =====================
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = await loadUser(strId, 'unknown');
  user.balance += amt;
  await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
  res.json({ success: true, newBalance: user.balance });
});

// ===================== Bingo card generator (5x5) =====================
function generateCard() {
  const columns = [
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],
    [31,32,33,34,35,36,37,38,39,40,41,42,43,44,45],
    [46,47,48,49,50,51,52,53,54,55,56,57,58,59,60],
    [61,62,63,64,65,66,67,68,69,70,71,72,73,74,75]
  ];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const colNumbers = [];
    const available = [...columns[col]];
    for (let row = 0; row < 5; row++) {
      if (col === 2 && row === 2) {
        colNumbers.push('FREE');
      } else {
        const idx = Math.floor(Math.random() * available.length);
        colNumbers.push(available.splice(idx, 1)[0]);
      }
    }
    card.push(colNumbers);
  }
  // transpose to row-major
  const transposed = [];
  for (let r = 0; r < 5; r++) {
    transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  }
  return transposed;
}

// ===================== Game state =====================
const currentGame = {
  status: 'lobby',
  players: [],             // { telegramId, username, card (5x5), markedNumbers, cardNumber (1-100) }
  calledNumbers: [],
  entryFee: 10,
  prizePool: 0,
  lobbyTimer: null,
  callInterval: null,
  lobbyEndTime: 0,
  // Pre‑generated 100 bingo cards (index 1..100)
  cardSet: Array.from({ length: 100 }, () => generateCard())
};

function resetGame() {
  clearInterval(currentGame.callInterval);
  clearTimeout(currentGame.lobbyTimer);
  currentGame.status = 'lobby';
  currentGame.players = [];
  currentGame.calledNumbers = [];
  currentGame.prizePool = 0;
  currentGame.lobbyEndTime = Date.now() + 30000;
  currentGame.cardSet = Array.from({ length: 100 }, () => generateCard()); // new card set each lobby
  io.emit('lobbyState', { startsIn: 30 });
  currentGame.lobbyTimer = setTimeout(() => startGame(), 30000);
}

function startGame() {
  if (currentGame.players.length === 0) {
    currentGame.status = 'ended';
    setTimeout(resetGame, 3000);
    return;
  }

  // Deduct entry fee
  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= currentGame.entryFee;
      supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId).then();
    }
  }

  currentGame.prizePool = currentGame.entryFee * currentGame.players.length;
  currentGame.status = 'running';
  currentGame.calledNumbers = [];

  io.emit('gameStarted');
  startCalling();
}

function startCalling() {
  currentGame.callInterval = setInterval(() => {
    if (currentGame.status !== 'running') {
      clearInterval(currentGame.callInterval);
      return;
    }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !currentGame.calledNumbers.includes(n));
    if (available.length === 0) {
      clearInterval(currentGame.callInterval);
      endGame(null);
      return;
    }
    const number = available[Math.floor(Math.random() * available.length)];
    currentGame.calledNumbers.push(number);
    io.emit('numberCalled', { number, calledNumbers: currentGame.calledNumbers });
  }, 4000);
}

function checkBingo(card, marked) {
  const c = card.map(row => row.map(cell => cell === 'FREE' ? 'FREE' : cell));
  for (let r = 0; r < 5; r++) if (c[r].every(v => v === 'FREE' || marked.includes(v))) return true;
  for (let col = 0; col < 5; col++) if ([0,1,2,3,4].every(r => c[r][col] === 'FREE' || marked.includes(c[r][col]))) return true;
  if ([0,1,2,3,4].every(i => c[i][i] === 'FREE' || marked.includes(c[i][i]))) return true;
  if ([0,1,2,3,4].every(i => c[i][4-i] === 'FREE' || marked.includes(c[i][4-i]))) return true;
  return false;
}

function endGame(winnerTelegramId) {
  currentGame.status = 'ended';
  clearInterval(currentGame.callInterval);
  if (winnerTelegramId) {
    const winner = currentGame.players.find(p => p.telegramId === winnerTelegramId);
    if (winner && users[winner.telegramId]) {
      users[winner.telegramId].balance += currentGame.prizePool;
      supabase.from('users').update({ balance: users[winner.telegramId].balance }).eq('telegram_id', winner.telegramId).then();
    }
    io.emit('gameEnded', { winner: winner ? winner.username : 'Unknown' });
  } else {
    io.emit('gameEnded', { noWinner: true });
  }
  setTimeout(resetGame, 5000);
}

// ===================== Socket.IO authentication =====================
io.use((socket, next) => {
  const s = socket.request.session;
  if (!s?.userId) return next(new Error('Unauthorized'));
  socket.userId = s.userId;
  socket.username = users[s.userId]?.username || 'Player';
  next();
});

// ===================== Socket events =====================
io.on('connection', async (socket) => {
  const user = users[socket.userId];
  socket.emit('balanceUpdate', user ? user.balance : 0);

  // Send current lobby/game state
  if (currentGame.status === 'lobby') {
    const timeLeft = Math.max(0, Math.ceil((currentGame.lobbyEndTime - Date.now()) / 1000));
    socket.emit('lobbyState', { startsIn: timeLeft });
  } else if (currentGame.status === 'running') {
    socket.emit('gameStarted');
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (player) {
      socket.emit('yourCard', player.card);
      socket.emit('markedNumbers', player.markedNumbers);
      socket.emit('calledNumbers', currentGame.calledNumbers);
    }
  }

  // --- Join lobby (initial auto-join) ---
  socket.on('joinLobby', async () => {
    if (currentGame.status !== 'lobby') return;
    if (currentGame.players.find(p => p.telegramId === socket.userId)) return; // already in
    // Wait for card selection, so don't assign yet.
    // Just acknowledge.
    // Emit current player count.
    io.emit('playersCount', currentGame.players.length);
  });

  // --- Select card number (1-100) ---
  socket.on('selectCardNumber', async (cardNumber) => {
    if (currentGame.status !== 'lobby') return;
    if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 100) return;

    let player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) {
      // Create player entry
      player = {
        telegramId: socket.userId,
        username: socket.username,
        card: null,
        markedNumbers: [],
        cardNumber: 0
      };
      currentGame.players.push(player);
    }

    // Assign card based on selection
    player.card = currentGame.cardSet[cardNumber - 1];  // 1-indexed
    player.cardNumber = cardNumber;
    player.markedNumbers = [];

    socket.emit('yourCard', player.card);
    io.emit('playersCount', currentGame.players.length);
  });

  // --- New card number (random by server) ---
  socket.on('newCardNumber', () => {
    if (currentGame.status !== 'lobby') return;
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    // Assign a random unused? Actually any. Use random from 1-100
    const newNum = Math.floor(Math.random() * 100) + 1;
    player.card = currentGame.cardSet[newNum - 1];
    player.cardNumber = newNum;
    socket.emit('yourCard', player.card);
    socket.emit('cardNumberAssigned', newNum); // optional
  });

  // --- Game: mark number ---
  socket.on('markNumber', (number) => {
    if (currentGame.status !== 'running') return;
    if (!currentGame.calledNumbers.includes(number)) return;
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const flatCard = player.card.flat().filter(c => c !== 'FREE');
    if (!flatCard.includes(number)) return;
    if (!player.markedNumbers.includes(number)) {
      player.markedNumbers.push(number);
      socket.emit('markedNumbers', player.markedNumbers);
    }
  });

  // --- Claim bingo ---
  socket.on('claimBingo', () => {
    if (currentGame.status !== 'running') return;
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    if (checkBingo(player.card, player.markedNumbers)) {
      endGame(player.telegramId);
    } else {
      socket.emit('invalidBingo');
    }
  });

  // --- Balance refresh ---
  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });

  // --- Withdraw request (just logs) ---
  socket.on('requestWithdraw', () => {
    console.log(`Withdraw request from ${socket.userId} (${socket.username})`);
    // Could store in DB or notify admin
    socket.emit('withdrawRequested', 'Your withdraw request has been sent to admin.');
  });

  socket.on('disconnect', () => {});
});

// ===================== Start first lobby =====================
resetGame();

// ===================== Launch server =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Bingo server on port ${PORT}`));
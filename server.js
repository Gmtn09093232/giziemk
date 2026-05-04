require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// =====================
// Supabase client
// =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// App initialisation
// =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }   // set true if using HTTPS (recommended)
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================
// In‑memory cache (synced with Supabase)
// =====================
let users = {};   // telegramId => { id, username, balance }

async function loadUser(telegramId, username) {
  const strId = String(telegramId);
  if (users[strId]) return users[strId];

  // Try DB
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', strId)
    .maybeSingle();

  if (data) {
    users[strId] = {
      id: strId,
      username: data.username || username,
      balance: Number(data.balance)
    };
  } else {
    // Create new player with starting bonus
    const newUser = {
      telegram_id: strId,
      username: username || 'Player',
      balance: 1000   // change to 0 if you want no starting balance
    };
    await supabase.from('users').insert(newUser);
    users[strId] = {
      id: strId,
      username: newUser.username,
      balance: newUser.balance
    };
  }
  return users[strId];
}

// =====================
// Telegram auth verification
// =====================
function verifyTelegram(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return calculatedHash === hash;
}

// =====================
// Auth endpoint
// =====================
app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) {
    return res.status(403).json({ success: false, error: 'Invalid Telegram data' });
  }

  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);

  const user = await loadUser(id, userData.first_name || userData.username);
  req.session.userId = id;

  res.json({
    success: true,
    userId: id,
    username: user.username,
    balance: user.balance
  });
});

// =====================
// Admin add‑balance endpoint
// =====================
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;

  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  // Ensure user exists in cache (and DB)
  const user = await loadUser(strId, 'unknown');

  user.balance += amt;

  // Update Supabase
  const { error } = await supabase
    .from('users')
    .update({ balance: user.balance })
    .eq('telegram_id', strId);

  if (error) {
    console.error('DB update error:', error);
    return res.status(500).json({ success: false, error: 'Database error' });
  }

  // Notify online player(s)
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) {
    playerSocket.emit('balanceUpdate', user.balance);
  }

  res.json({ success: true, newBalance: user.balance });
});

// =====================
// Bingo card generator (5x5, centre FREE)
// =====================
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

  // Transpose so card[row][col] is standard
  const transposed = [];
  for (let r = 0; r < 5; r++) {
    transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  }
  return transposed;
}

// =====================
// Game state (singleton)
// =====================
let currentGame = {
  status: 'lobby',           // 'lobby' | 'running' | 'ended'
  players: [],               // { telegramId, username, card, markedNumbers }
  calledNumbers: [],
  entryFee: 10,
  prizePool: 0,
  lobbyTimer: null,
  callInterval: null,
  startTime: null
};

function resetGame() {
  clearInterval(currentGame.callInterval);
  clearTimeout(currentGame.lobbyTimer);
  currentGame = {
    status: 'lobby',
    players: [],
    calledNumbers: [],
    entryFee: 10,
    prizePool: 0,
    lobbyTimer: null,
    callInterval: null,
    startTime: Date.now()
  };
  io.emit('lobbyStarted', { startsIn: 30 });
}

function startLobby() {
  resetGame();
  currentGame.lobbyTimer = setTimeout(() => startGame(), 30000);
}

function startGame() {
  if (currentGame.players.length === 0) {
    // No players – go back to lobby
    currentGame.status = 'ended';
    setTimeout(startLobby, 3000);
    return;
  }

  // Deduct entry fee for each player (balance already checked when joining)
  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (user) user.balance -= currentGame.entryFee;
    // Update DB asynchronously (can be batched later)
    supabase
      .from('users')
      .update({ balance: user.balance })
      .eq('telegram_id', p.telegramId)
      .then();
  }

  currentGame.prizePool = currentGame.entryFee * currentGame.players.length;
  currentGame.status = 'running';
  currentGame.calledNumbers = [];
  currentGame.startTime = Date.now();

  io.emit('gameStarted');
  callNextNumberLoop();
}

function callNextNumberLoop() {
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
  // Rows
  for (let r = 0; r < 5; r++) {
    if (c[r].every(v => v === 'FREE' || marked.includes(v))) return true;
  }
  // Columns
  for (let col = 0; col < 5; col++) {
    if ([0,1,2,3,4].every(r => c[r][col] === 'FREE' || marked.includes(c[r][col]))) return true;
  }
  // Diagonals
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
      // Update DB
      supabase
        .from('users')
        .update({ balance: users[winner.telegramId].balance })
        .eq('telegram_id', winner.telegramId)
        .then();
    }
    io.emit('gameEnded', { winner: winner?.username || 'Unknown' });
  } else {
    io.emit('gameEnded', { noWinner: true });
  }

  // Back to lobby after 5 seconds
  setTimeout(startLobby, 5000);
}

// =====================
// Socket.IO authentication
// =====================
io.use((socket, next) => {
  const session = socket.request.session;
  if (!session?.userId) return next(new Error('Unauthorized'));
  socket.userId = session.userId;
  socket.username = users[session.userId]?.username || 'Player';
  next();
});

// =====================
// Socket events
// =====================
io.on('connection', async (socket) => {
  // Send current state
  const user = users[socket.userId];
  socket.emit('balanceUpdate', user ? user.balance : 0);

  if (currentGame.status === 'lobby') {
    const timeLeft = currentGame.startTime
      ? Math.max(0, Math.ceil((currentGame.startTime + 30000 - Date.now()) / 1000))
      : 30;
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

  // Join room (lobby)
  socket.on('joinLobby', async () => {
    if (currentGame.status !== 'lobby') return;

    // Check if already joined
    if (currentGame.players.find(p => p.telegramId === socket.userId)) {
      // Update card maybe
      return;
    }

    // Check balance
    const user = await loadUser(socket.userId, socket.username);
    if (user.balance < currentGame.entryFee) {
      socket.emit('errorMsg', 'Insufficient balance');
      return;
    }

    const card = generateCard();
    currentGame.players.push({
      telegramId: socket.userId,
      username: socket.username,
      card,
      markedNumbers: []
    });

    socket.emit('yourCard', card);
    io.emit('playersCount', currentGame.players.length);
  });

  // Request a new card (lobby only)
  socket.on('newCard', () => {
    if (currentGame.status !== 'lobby') return;
    const idx = currentGame.players.findIndex(p => p.telegramId === socket.userId);
    if (idx === -1) return;
    currentGame.players[idx].card = generateCard();
    socket.emit('yourCard', currentGame.players[idx].card);
  });

  // Mark a number (game only)
  socket.on('markNumber', (number) => {
    if (currentGame.status !== 'running') return;
    if (!currentGame.calledNumbers.includes(number)) return;

    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;

    // Check if number is on the player's card
    const flatCard = player.card.flat().filter(c => c !== 'FREE');
    if (!flatCard.includes(number)) return;

    if (!player.markedNumbers.includes(number)) {
      player.markedNumbers.push(number);
      socket.emit('markedNumbers', player.markedNumbers);
    }
  });

  // Claim Bingo
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

  // Sync balance
  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });

  socket.on('disconnect', () => {});
});

// =====================
// Start first lobby
// =====================
startLobby();

// =====================
// Launch server
// =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Bingo server running on port ${PORT}`);
});
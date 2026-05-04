require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ------------------- Supabase -------------------
console.log('Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Quick DB connection test
(async () => {
  const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
  if (error) console.error('❌ Supabase connection error:', error.message);
  else console.log('✅ Supabase connected');
})();

// ------------------- App -------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }   // set true if using HTTPS in production
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// Serve the main HTML page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ------------------- User cache -------------------
const users = {};               // telegramId -> { id, username, balance }

async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];

  console.log(`Loading user ${id} from DB...`);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', id)
    .maybeSingle();

  if (error) console.error('DB load error:', error);

  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
    console.log('User found:', id);
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 1000 };
    const { error: insertError } = await supabase.from('users').insert(newUser);
    if (insertError) console.error('Insert error:', insertError);
    else console.log('New user created:', id);
    users[id] = { id, username: newUser.username, balance: 1000 };
  }
  return users[id];
}

// ------------------- Telegram verification -------------------
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
  const ok = calculatedHash === hash;
  console.log('Telegram verify:', ok);
  return ok;
}

// ------------------- Auth endpoint (correct route) -------------------
app.post('/api/telegram-miniapp-auth', async (req, res) => {
  console.log('Auth request received');
  const { initData } = req.body;
  if (!initData) {
    console.log('Missing initData');
    return res.status(400).json({ success: false, error: 'Missing initData' });
  }

  if (!verifyTelegram(initData)) {
    console.log('Invalid Telegram data');
    return res.status(403).json({ success: false, error: 'Invalid Telegram data' });
  }

  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);
  console.log('Authenticating user:', id);

  const user = await loadUser(id, userData.first_name || userData.username);
  req.session.userId = id;
  req.session.save(err => {
    if (err) console.error('Session save error:', err);
    else console.log('Session saved for', id);
  });

  res.json({ success: true, userId: id, username: user.username, balance: user.balance });
});

// ------------------- Admin add balance -------------------
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const user = await loadUser(strId, 'unknown');
  user.balance += amt;
  await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);

  // Notify online player
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);

  res.json({ success: true, newBalance: user.balance });
});

// ------------------- Bingo card generator -------------------
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

// ------------------- Game state (multiplayer) -------------------
const currentGame = {
  status: 'lobby',
  players: [],
  takenCardNumbers: new Set(),
  calledNumbers: [],
  entryFee: 10,
  prizePool: 0,
  lobbyTimer: null,
  callInterval: null,
  lobbyEndTime: 0,
  cardSet: Array.from({ length: 100 }, () => generateCard())
};

function resetGame() {
  clearInterval(currentGame.callInterval);
  clearTimeout(currentGame.lobbyTimer);
  currentGame.status = 'lobby';
  currentGame.players = [];
  currentGame.takenCardNumbers.clear();
  currentGame.calledNumbers = [];
  currentGame.prizePool = 0;
  currentGame.lobbyEndTime = Date.now() + 30000;
  currentGame.cardSet = Array.from({ length: 100 }, () => generateCard());
  console.log('Lobby reset');
  io.emit('lobbyState', { startsIn: 30, takenNumbers: [] });
  currentGame.lobbyTimer = setTimeout(() => startGame(), 30000);
}

function startGame() {
  if (currentGame.players.length === 0) {
    currentGame.status = 'ended';
    setTimeout(resetGame, 3000);
    return;
  }

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
  console.log('Game started, players:', currentGame.players.length);
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
  console.log('Game ended');
  setTimeout(resetGame, 5000);
}

// ------------------- Socket.IO auth -------------------
io.use((socket, next) => {
  const req = socket.request;
  console.log('Socket handshake - session:', req.session);
  if (!req.session?.userId) {
    console.log('Socket auth failed: no session userId');
    return next(new Error('Unauthorized'));
  }
  socket.userId = req.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  console.log('Socket authenticated:', socket.userId);
  next();
});

// ------------------- Socket events -------------------
io.on('connection', async (socket) => {
  console.log('Socket connected:', socket.userId);
  const user = users[socket.userId];
  socket.emit('balanceUpdate', user ? user.balance : 0);

  // Send current state on connect
  if (currentGame.status === 'lobby') {
    const timeLeft = Math.max(0, Math.ceil((currentGame.lobbyEndTime - Date.now()) / 1000));
    socket.emit('lobbyState', {
      startsIn: timeLeft,
      takenNumbers: Array.from(currentGame.takenCardNumbers)
    });
  } else if (currentGame.status === 'running') {
    socket.emit('gameStarted');
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (player) {
      socket.emit('yourCard', player.card);
      socket.emit('markedNumbers', player.markedNumbers);
      socket.emit('calledNumbers', currentGame.calledNumbers);
    }
  }

  // ---------- Lobby ----------
  socket.on('joinLobby', () => {
    console.log('joinLobby from', socket.userId);
  });

  socket.on('selectCardNumber', (cardNumber) => {
    console.log(`selectCardNumber ${cardNumber} from ${socket.userId}`);
    if (currentGame.status !== 'lobby') return;

    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;

    if (currentGame.takenCardNumbers.has(num)) {
      socket.emit('cardSelectionFailed', 'This number is already taken.');
      return;
    }

    // Remove previous selection by this player
    const existingPlayer = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existingPlayer) {
      currentGame.takenCardNumbers.delete(existingPlayer.cardNumber);
      currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId);
    }

    // Claim new number
    currentGame.takenCardNumbers.add(num);
    const player = {
      telegramId: socket.userId,
      username: socket.username,
      card: currentGame.cardSet[num - 1],
      markedNumbers: [],
      cardNumber: num
    };
    currentGame.players.push(player);

    io.emit('cardTaken', {
      number: num,
      takenNumbers: Array.from(currentGame.takenCardNumbers)
    });
    io.emit('playersCount', currentGame.players.length);
    socket.emit('yourCard', player.card);
    console.log('Players count:', currentGame.players.length);
  });

  // Random card button
  socket.on('newCardNumber', () => {
    if (currentGame.status !== 'lobby') return;
    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) {
      if (!currentGame.takenCardNumbers.has(i)) freeNumbers.push(i);
    }
    if (freeNumbers.length === 0) {
      socket.emit('cardSelectionFailed', 'All numbers are taken.');
      return;
    }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];

    const existingPlayer = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existingPlayer) {
      currentGame.takenCardNumbers.delete(existingPlayer.cardNumber);
      currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId);
    }

    currentGame.takenCardNumbers.add(randomNum);
    const player = {
      telegramId: socket.userId,
      username: socket.username,
      card: currentGame.cardSet[randomNum - 1],
      markedNumbers: [],
      cardNumber: randomNum
    };
    currentGame.players.push(player);

    io.emit('cardTaken', {
      number: randomNum,
      takenNumbers: Array.from(currentGame.takenCardNumbers)
    });
    io.emit('playersCount', currentGame.players.length);
    socket.emit('yourCard', player.card);
  });

  // Game events
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

  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });

  socket.on('requestWithdraw', () => {
    console.log(`Withdraw request from ${socket.userId} (${socket.username})`);
    socket.emit('withdrawRequested', 'Your withdraw request has been sent to admin.');
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.userId);
  });
});

// ------------------- Start first lobby -------------------
resetGame();

// ------------------- Start server -------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));
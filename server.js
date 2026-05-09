require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Create uploads folder if missing
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer config: store file with unique name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

// ------------------- Supabase -------------------
console.log('Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
  if (error) console.error('❌ Supabase error:', error.message);
  else console.log('✅ Supabase connected');
})();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use('/uploads', express.static(uploadDir)); // serve proof images

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none'
  }
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

app.get('/api/admin-phone', (req, res) => {
  res.json({ phone: process.env.ADMIN_PHONE || '0924839730' });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/test-deposit', (req, res) => res.json({ ok: true }));

// ------------------- User cache -------------------
const users = {};
async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];
  const { data } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 5 };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 5 };
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
  return calculatedHash === hash;
}

// ------------------- Auth endpoint -------------------
app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) return res.status(403).json({ success: false });

  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);
  const user = await loadUser(id, userData.first_name || userData.username);

  req.session.userId = id;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ success: false, error: 'Session save failed' });
    }
    res.json({ success: true, userId: id, username: user.username, balance: user.balance });
  });
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
      if (col === 2 && row === 2) { colNumbers.push('FREE'); }
      else { colNumbers.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]); }
    }
    card.push(colNumbers);
  }
  const transposed = [];
  for (let r = 0; r < 5; r++) transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  return transposed;
}

// ------------------- Game state -------------------
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
  io.emit('lobbyState', { startsIn: 30, takenNumbers: [] });
  currentGame.lobbyTimer = setTimeout(() => startGame(), 30000);
}

async function startGame() {
  // ----- NEW: Remove players with insufficient balance before game starts -----
  const toRemove = [];
  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (!user || user.balance < currentGame.entryFee) {
      toRemove.push(p);
    }
  }
  if (toRemove.length > 0) {
    for (const p of toRemove) {
      const idx = currentGame.players.findIndex(player => player.telegramId === p.telegramId);
      if (idx !== -1) currentGame.players.splice(idx, 1);
      if (p.cardNumber) currentGame.takenCardNumbers.delete(p.cardNumber);
    }
    // Broadcast updated taken numbers & player count
    io.emit('cardTaken', { takenNumbers: Array.from(currentGame.takenCardNumbers) });
    io.emit('playersCount', currentGame.players.length);
  }

  if (currentGame.players.length === 0) {
    currentGame.status = 'ended';
    setTimeout(resetGame, 3000);
    return;
  }

  // Deduct entry fee from all remaining players
  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= currentGame.entryFee;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      // Notify each player about their new balance
      const socket = await getSocketByUserId(p.telegramId);
      if (socket) socket.emit('balanceUpdate', user.balance);
    }
  }
  currentGame.prizePool = 0.8 * (currentGame.entryFee * currentGame.players.length);
  currentGame.status = 'running';
  currentGame.calledNumbers = [];
  io.emit('gameStarted');
  startCalling();
}

// Helper to find a socket by userId
async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

function startCalling() {
  currentGame.callInterval = setInterval(() => {
    if (currentGame.status !== 'running') { clearInterval(currentGame.callInterval); return; }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !currentGame.calledNumbers.includes(n));
    if (available.length === 0) { clearInterval(currentGame.callInterval); endGame(null); return; }
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
  const corners = [c[0][0], c[0][4], c[4][0], c[4][4]];
  if (corners.every(v => v === 'FREE' || marked.includes(v))) return true;
  return false;
}


function endGame(winnerTelegramId, isLate = false) {
  currentGame.status = 'ended';
  clearInterval(currentGame.callInterval);
  if (winnerTelegramId) {
    const winner = currentGame.players.find(p => p.telegramId === winnerTelegramId);
    if (winner && users[winner.telegramId]) {
      users[winner.telegramId].balance += currentGame.prizePool;
      supabase
        .from('users')
        .update({ balance: users[winner.telegramId].balance })
        .eq('telegram_id', winner.telegramId)
        .then();
      // Notify the winner of new balance
     const winnerSocket = // Find the socket for the winner
        io.fetchSockets().then(sockets => sockets.find(s => s.userId === winner.telegramId));
      if (winnerSocket) winnerSocket.emit('balanceUpdate', users[winner.telegramId].balance);
      // Also emit globally so UI can refresh
      io.emit('balanceUpdate', users[winner.telegramId].balance);
    }
    io.emit('gameEnded', { winner: winner ? winner.username : 'Unknown', late: isLate });
  } else {
    io.emit('gameEnded', { noWinner: true });
  }
  setTimeout(resetGame, 5000);
}

// ------------------- DEPOSIT (with phone + proof image) -------------------
app.post('/api/request-deposit', upload.single('proof'), async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { phone, amount } = req.body;
  const file = req.file;
  if (!phone || !/^0\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid phone number required (09xxxxxxxx)' });
  }
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!file) return res.status(400).json({ error: 'Proof image required' });

  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const proofPath = `/uploads/${file.filename}`;

  const { data, error } = await supabase
    .from('deposit_requests')
    .insert({
      telegram_id: userId,
      username: user.username,
      amount: amt,
      status: 'pending',
      phone: phone,
      proof_path: proofPath
    })
    .select()
    .single();

  if (error) {
    console.error('Deposit insert error:', error.message);
    return res.status(500).json({ error: 'Internal error' });
  }
  res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB from ${phone} submitted with proof.` });
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const { data: reqData, error: fetchErr } = await supabase
    .from('deposit_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    const { error: updateErr } = await supabase
      .from('deposit_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) {
      playerSocket.emit('balanceUpdate', user.balance);
      playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount });
    }
    res.json({ success: true, newBalance: user.balance });
  } else {
    const { error: updateErr } = await supabase
      .from('deposit_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ------------------- WITHDRAWAL -------------------
app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { amount, phone } = req.body;
  if (!phone || !/^0\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const user = await loadUser(userId, null);
  if (!user || user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

  const { data, error } = await supabase
    .from('withdrawal_requests')
    .insert({ telegram_id: userId, username: user.username, amount: amt, status: 'pending', phone_number: phone })
    .select()
    .single();

  if (error) { console.error('Withdraw insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  res.json({ success: true, requestId: data.id, message: `Withdrawal request of ${amt} ETB to ${phone} submitted.` });
});

app.get('/admin/withdrawals', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase
    .from('withdrawal_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const { data: reqData, error: fetchErr } = await supabase
    .from('withdrawal_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
    user.balance -= reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    const { error: updateErr } = await supabase
      .from('withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) {
      playerSocket.emit('balanceUpdate', user.balance);
      playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number });
    }
    res.json({ success: true, newBalance: user.balance });
  } else {
    const { error: updateErr } = await supabase
      .from('withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ------------------- Socket.IO with Balance Check on Join -------------------
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  socket.emit('balanceUpdate', users[socket.userId]?.balance || 0);
  if (currentGame.status === 'lobby') {
    const timeLeft = Math.max(0, Math.ceil((currentGame.lobbyEndTime - Date.now()) / 1000));
    socket.emit('lobbyState', { startsIn: timeLeft, takenNumbers: Array.from(currentGame.takenCardNumbers) });
  } else if (currentGame.status === 'running') {
    socket.emit('gameStarted');
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (player) {
      socket.emit('yourCard', player.card);
      socket.emit('markedNumbers', player.markedNumbers);
      socket.emit('calledNumbers', currentGame.calledNumbers);
    }
  }

  // Select a specific card number (only allowed if balance >= entryFee)
  socket.on('selectCardNumber', (cardNumber) => {
    if (currentGame.status !== 'lobby') return;
    
    // ----- BALANCE CHECK -----
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentGame.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${currentGame.entryFee} birr.`);
      return;
    }

    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (currentGame.takenCardNumbers.has(num)) {
      socket.emit('cardSelectionFailed', 'This number is already taken.');
      return;
    }
    const existingPlayer = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existingPlayer) {
      currentGame.takenCardNumbers.delete(existingPlayer.cardNumber);
      currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId);
    }
    currentGame.takenCardNumbers.add(num);
    const player = { telegramId: socket.userId, username: socket.username, card: currentGame.cardSet[num - 1], markedNumbers: [], cardNumber: num };
    currentGame.players.push(player);
    io.emit('cardTaken', { number: num, takenNumbers: Array.from(currentGame.takenCardNumbers) });
    io.emit('playersCount', currentGame.players.length);
    socket.emit('yourCard', player.card);
  });

  // Get a random free card number (only allowed if balance >= entryFee)
  socket.on('newCardNumber', () => {
    if (currentGame.status !== 'lobby') return;
    
    // ----- BALANCE CHECK -----
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentGame.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${currentGame.entryFee} birr.`);
      return;
    }

    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) if (!currentGame.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) { socket.emit('cardSelectionFailed', 'All numbers are taken.'); return; }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existingPlayer = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existingPlayer) {
      currentGame.takenCardNumbers.delete(existingPlayer.cardNumber);
      currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId);
    }
    currentGame.takenCardNumbers.add(randomNum);
    const player = { telegramId: socket.userId, username: socket.username, card: currentGame.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum };
    currentGame.players.push(player);
    io.emit('cardTaken', { number: randomNum, takenNumbers: Array.from(currentGame.takenCardNumbers) });
    io.emit('playersCount', currentGame.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('markNumber', (number) => {
    if (currentGame.status !== 'running') return;
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const num = Number(number);
    if (number !== 'FREE' && (!Number.isInteger(num) || num < 1 || num > 75)) return;
    const flatCard = player.card.flat();
    if (!flatCard.includes(number)) return;
    if (!currentGame.calledNumbers.includes(num) && number !== 'FREE') return;
    if (player.markedNumbers.includes(number)) return;
    player.markedNumbers.push(number);
    socket.emit('markedNumbers', player.markedNumbers);
  });
socket.on('claimBingo', () => {
  if (currentGame.status !== 'running') return;

  const player = currentGame.players.find(
    p => p.telegramId === socket.userId
  );

  if (!player) return;

  // STRICT MODE:
  // Bingo must be claimed before next number call.
  // Missed bingo becomes invalid automatically.

  if (checkBingo(player.card, player.markedNumbers)) {
    endGame(socket.userId, false);
  } else {
    socket.emit('invalidBingo');
  }
});
  socket.on('getBalance', async () => { const u = await loadUser(socket.userId, socket.username); socket.emit('balanceUpdate', u.balance); });
  socket.on('requestWithdraw', () => { socket.emit('withdrawRequested', 'Withdraw request sent.'); });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start the first lobby
resetGame();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));

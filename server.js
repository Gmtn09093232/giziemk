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
(async () => {
  const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
  if (error) console.error('❌ Supabase error:', error.message);
  else console.log('✅ Supabase connected');
})();

const app = express();
app.set('trust proxy', 1);   // REQUIRED for secure cookies on Render

const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,            // ✅ must be true on HTTPS
    httpOnly: true,
    sameSite: 'none'         // allows cross‑origin iframes (Telegram Mini App)
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

  // Set the user ID in the session and WAIT for the save to complete
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

// ------------------- Bingo card generator (unchanged) -------------------
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
  currentGame.prizePool = 0.8*currentGame.entryFee * currentGame.players.length;
  currentGame.status = 'running';
  currentGame.calledNumbers = [];
  io.emit('gameStarted');
  startCalling();
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

  // Check rows
  for (let r = 0; r < 5; r++) {
    if (c[r].every(v => v === 'FREE' || marked.includes(v))) return true;
  }
  // Check columns
  for (let col = 0; col < 5; col++) {
    if ([0,1,2,3,4].every(r => c[r][col] === 'FREE' || marked.includes(c[r][col]))) return true;
  }
  // Check main diagonal (top‑left to bottom‑right)
  if ([0,1,2,3,4].every(i => c[i][i] === 'FREE' || marked.includes(c[i][i]))) return true;
  // Check anti‑diagonal (top‑right to bottom‑left)
  if ([0,1,2,3,4].every(i => c[i][4-i] === 'FREE' || marked.includes(c[i][4-i]))) return true;

  // 🔲 Check four corners
  const corners = [c[0][0], c[0][4], c[4][0], c[4][4]];
  if (corners.every(v => v === 'FREE' || marked.includes(v))) return true;

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
  } else io.emit('gameEnded', { noWinner: true });
  setTimeout(resetGame, 5000);
}

// ---- Deposit ----

app.post('/api/request-deposit', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { amount } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data, error } = await supabase
    .from('deposit_requests')
    .insert({ telegram_id: userId, username: user.username, amount: amt, status: 'pending' })
    .select()
    .single();

  if (error) { console.error('Deposit insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  res.json({ success: true, requestId: data.id, message: 'Deposit request submitted. Complete payment and admin will approve.' });
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('deposit_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;  // action: 'approve' or 'reject'
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

// ---- Withdrawal ----

app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { amount, phone } = req.body;
  if (!phone || !/^0\d{9}$/.test(phone)) {       // simple validation: starts with 0, 10 digits
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
  res.json({ success: true, requestId: data.id, message: 'Withdrawal request submitted. Admin will review.' });
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

// ------------------- Socket.IO auth -------------------
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

// ------------------- Socket events (unchanged) -------------------
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

  socket.on('selectCardNumber', (cardNumber) => {
    if (currentGame.status !== 'lobby') return;
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

  socket.on('newCardNumber', () => {
    if (currentGame.status !== 'lobby') return;
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
  // 1. Game must be running
  if (currentGame.status !== 'running') return;

  // 2. Find this player in the current game
  const player = currentGame.players.find(p => p.telegramId === socket.userId);
  if (!player) return;

  // 3. Validate the number
  const num = Number(number);
  // - must be a valid integer 1‑75 (or 'FREE' special case, but FREE is not clickable)
  if (number !== 'FREE' && (!Number.isInteger(num) || num < 1 || num > 75)) return;

  // 4. Only allow marking if the number is actually on this player's card
  const flatCard = player.card.flat();   // all cell values
  if (!flatCard.includes(number)) return;

  // 5. Only allow marking if the number has been CALLED (standard bingo rule)
  if (!currentGame.calledNumbers.includes(num) && number !== 'FREE') return;

  // 6. Don't mark the same number twice
  if (player.markedNumbers.includes(number)) return;

  // 7. Add the number to marked numbers
  player.markedNumbers.push(number);

  // 8. Send updated marked numbers ONLY to this player
  socket.emit('markedNumbers', player.markedNumbers);

  // OPTIONAL: auto‑check bingo here, but the player has a separate “BINGO” button
});
  socket.on('claimBingo', () => {
  // Game must be running
  if (currentGame.status !== 'running') return;

  // Find the player who pressed BINGO
  const player = currentGame.players.find(p => p.telegramId === socket.userId);
  if (!player) return;

  // Check if the player has a valid bingo
  if (checkBingo(player.card, player.markedNumbers)) {
    endGame(socket.userId);               // 🎉 winner!
  } else {
    socket.emit('invalidBingo');          // ❌ not a valid bingo
  }
});
  socket.on('getBalance', async () => { const u = await loadUser(socket.userId, socket.username); socket.emit('balanceUpdate', u.balance); });
  socket.on('requestWithdraw', () => { socket.emit('withdrawRequested', 'Withdraw request sent.'); });
});

// ---- Place this AFTER all your routes and the static file middleware ----
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  // Always reply with JSON, never HTML
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});



// ------------------- Start first lobby -------------------
resetGame();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));

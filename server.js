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

// ---------- Uploads setup ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Supabase ----------
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
app.use('/uploads', express.static(uploadDir));

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

// ---------- Audit Logger (inline) ----------
async function logAuditEvent({
  eventType,
  roomId = null,
  userId = 'system',
  ipAddress = null,
  details = {}
}) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({
        event_type: eventType,
        room_id: roomId,
        user_id: userId,
        ip_address: ipAddress,
        details
      });
    if (error) throw error;
  } catch (err) {
    console.error(`[AUDIT FAIL] ${eventType} (user ${userId}):`, err.message);
  }
}

const Audit = {
  depositInitiated(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_INITIATED', userId, ipAddress: ip, details: data }); },
  depositCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_COMPLETED', userId, ipAddress: ip, details: data }); },
  depositFailed(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_FAILED', userId, ipAddress: ip, details: data }); },
  withdrawalRequested(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REQUESTED', userId, ipAddress: ip, details: data }); },
  withdrawalCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_COMPLETED', userId, ipAddress: ip, details: data }); },
  withdrawalRejected(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REJECTED', userId, ipAddress: ip, details: data }); },
  bingoCalled(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_CALLED', roomId, userId, ipAddress: ip, details: data }); },
  bingoRejected(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_REJECTED', roomId, userId, ipAddress: ip, details: data }); },
  winPaidOut(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'WIN_PAID_OUT', roomId, userId, ipAddress: ip, details: data }); },
  numberDrawn(roomId, data) { return logAuditEvent({ eventType: 'NUMBER_DRAWN', roomId, details: data }); },
  cardAssigned(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'CARD_ASSIGNED', roomId, userId, ipAddress: ip, details: data }); },
  adminAction(eventType, adminId, ip, details) { return logAuditEvent({ eventType, userId: adminId, ipAddress: ip, details }); },
  suspicious(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'SUSPICIOUS_BEHAVIOR_DETECTED', roomId, userId, ipAddress: ip, details: data }); }
};

// ---------- Suspicious Activity Detector ----------
const winTimestamps = new Map();
const WINDOW_MS = 120_000;
const MAX_WINS_IN_WINDOW = 3;

function detectRapidWins(roomId, userId, ip) {
  if (!winTimestamps.has(userId)) winTimestamps.set(userId, []);
  const times = winTimestamps.get(userId);
  const now = Date.now();
  times.push(now);
  const recent = times.filter(t => now - t <= WINDOW_MS);
  winTimestamps.set(userId, recent);
  if (recent.length > MAX_WINS_IN_WINDOW) {
    Audit.suspicious(roomId, userId, ip, {
      detectionSource: 'win_velocity_check',
      reason: `More than ${MAX_WINS_IN_WINDOW} wins in ${WINDOW_MS/1000}s`,
      evidence: { recentWinCount: recent.length, windowMs: WINDOW_MS }
    });
    return true;
  }
  return false;
}

// ---------- Endpoints ----------
app.get('/api/deposit-accounts', (req, res) => {
  res.json({
    telebirr: process.env.ADMIN_PHONE || '0924839730',
    cbebirr: process.env.CBE_ACCOUNT || '1000123456789',
    mpesa: process.env.MPESA_ACCOUNT || '251912345678'
  });
});

app.get('/api/admin-phone', (req, res) => { res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }); });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- User cache ----------
const users = {};
async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];
  const { data } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 10 };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 10 };
  }
  return users[id];
}

// ---------- Telegram verification ----------
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

// ---------- Admin add balance ----------
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = await loadUser(strId, 'unknown');
  user.balance += amt;
  await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);
  Audit.adminAction('ADMIN_ADD_BALANCE', 'admin', req.ip, { targetUserId: strId, amount: amt, newBalance: user.balance });
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
  res.json({ success: true, newBalance: user.balance });
});

// ---------- Bingo card generator ----------
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

// ---------- Game state ----------
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
  cardSet: Array.from({ length: 100 }, () => generateCard()),
  winners: [],
  bingoGraceTimeout: null,
  winningNumber: null   // 👈 stores the last called number that triggered the win
};

function resetGame() {
  clearInterval(currentGame.callInterval);
  clearTimeout(currentGame.lobbyTimer);
  clearTimeout(currentGame.bingoGraceTimeout);
  currentGame.status = 'lobby';
  currentGame.players = [];
  currentGame.takenCardNumbers.clear();
  currentGame.calledNumbers = [];
  currentGame.prizePool = 0;
  currentGame.winners = [];
  currentGame.bingoGraceTimeout = null;
  currentGame.winningNumber = null;   // reset winning number
  currentGame.lobbyEndTime = Date.now() + 30000;
  currentGame.cardSet = Array.from({ length: 100 }, () => generateCard());
  io.emit('lobbyState', { startsIn: 30, takenNumbers: [], playersCount: 0 });
  currentGame.lobbyTimer = setTimeout(() => startGame(), 30000);
}

async function startGame() {
  const toRemove = [];
  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (!user || user.balance < currentGame.entryFee) toRemove.push(p);
  }
  for (const p of toRemove) {
    const idx = currentGame.players.findIndex(pl => pl.telegramId === p.telegramId);
    if (idx !== -1) currentGame.players.splice(idx, 1);
    if (p.cardNumber) currentGame.takenCardNumbers.delete(p.cardNumber);
  }
  io.emit('cardTaken', { takenNumbers: Array.from(currentGame.takenCardNumbers) });
  io.emit('playersCount', currentGame.players.length);

  if (currentGame.players.length === 0) {
    currentGame.status = 'ended';
    setTimeout(resetGame, 3000);
    return;
  }

  for (const p of currentGame.players) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= currentGame.entryFee;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      const socket = await getSocketByUserId(p.telegramId);
      if (socket) socket.emit('balanceUpdate', user.balance);
      Audit.adminAction('ENTRY_FEE_PAID', 'system', null, { userId: p.telegramId, amount: currentGame.entryFee, currency: 'ETB' });
    }
  }

  currentGame.prizePool = 0.8 * (currentGame.entryFee * currentGame.players.length);
  currentGame.status = 'running';
  currentGame.calledNumbers = [];
  currentGame.winningNumber = null;
  io.emit('gameStarted', { prizePool: currentGame.prizePool, playersCount: currentGame.players.length });
  startCalling();
}

async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

function startCalling() {
  currentGame.callInterval = setInterval(() => {
    if (currentGame.status !== 'running') { clearInterval(currentGame.callInterval); return; }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !currentGame.calledNumbers.includes(n));
    if (available.length === 0) {
      clearInterval(currentGame.callInterval);
      endGameWithWinners();
      return;
    }
    const number = available[Math.floor(Math.random() * available.length)];
    currentGame.calledNumbers.push(number);
    io.emit('numberCalled', { number, calledNumbers: currentGame.calledNumbers });
    Audit.numberDrawn('global', { drawnNumber: number, drawIndex: currentGame.calledNumbers.length, timestamp: new Date().toISOString() });
  }, 4000);
}

// ---------- Strict bingo check ----------
function getLines(card) {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([card[r][0], card[r][1], card[r][2], card[r][3], card[r][4]]);
  for (let c = 0; c < 5; c++) lines.push([card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]]);
  lines.push([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
  lines.push([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);
  lines.push([card[0][0], card[0][4], card[4][0], card[4][4]]);
  return lines;
}
function isLineComplete(line, marked) {
  return line.every(val => val === 'FREE' || marked.includes(val));
}
function isBingoValidOnLastCall(card, marked, lastCalled) {
  if (lastCalled === null) return false;
  const lines = getLines(card);
  for (const line of lines) {
    if (!isLineComplete(line, marked)) continue;
    if (!line.includes(lastCalled)) continue;
    return true;
  }
  return false;
}

// ---------- End game with multiple winners (sends winningNumber) ----------
async function endGameWithWinners() {
  currentGame.status = 'ended';
  clearInterval(currentGame.callInterval);

  if (currentGame.winners.length > 0) {
    const prizeEach = Math.floor(currentGame.prizePool / currentGame.winners.length);
    for (const w of currentGame.winners) {
      const user = users[w.telegramId];
      if (user) {
        user.balance += prizeEach;
        await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', w.telegramId);
        const sockets = await io.fetchSockets();
        const winnerSocket = sockets.find(s => s.userId === w.telegramId);
        if (winnerSocket) winnerSocket.emit('balanceUpdate', user.balance);
        Audit.winPaidOut('global', w.telegramId, null, {
          amount: prizeEach,
          currency: 'ETB',
          totalPrizePool: currentGame.prizePool,
          totalWinners: currentGame.winners.length
        });
        detectRapidWins('global', w.telegramId, null);
      }
    }

    const totalEntryFees = currentGame.players.length * currentGame.entryFee;
    const houseProfit = totalEntryFees - currentGame.prizePool;
    await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees,
      prize_pool: currentGame.prizePool,
      house_profit: houseProfit
    });

    // Collusion check by IP
    const ipCounts = {};
    currentGame.winners.forEach(w => {
      const player = currentGame.players.find(p => p.telegramId === w.telegramId);
      const ip = player ? player.ip : null;
      if (ip) ipCounts[ip] = (ipCounts[ip] || 0) + 1;
    });
    Object.entries(ipCounts).forEach(([ip, count]) => {
      if (count >= 3) {
        Audit.suspicious('global', 'system', ip, {
          detectionSource: 'multiple_winners_same_ip',
          reason: `${count} winners from IP ${ip}`,
          evidence: { winners: currentGame.winners.map(w => w.telegramId) }
        });
      }
    });

    const winnerNames = currentGame.winners.map(w => w.username);
    io.emit('gameEnded', {
      winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
      winners: winnerNames,
      prizeEach,
      totalPrize: currentGame.prizePool,
      winnerCount: currentGame.winners.length,
      winningNumber: currentGame.winningNumber   // 👈 send the exact winning number
    });
  } else {
    io.emit('gameEnded', { noWinner: true });
  }

  currentGame.winners = [];
  clearTimeout(currentGame.bingoGraceTimeout);
  currentGame.bingoGraceTimeout = null;
  setTimeout(resetGame, 5000);
}

// ---------- DEPOSIT (unchanged) ----------
app.post('/api/request-deposit', upload.single('proof'), async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { phone, amount, payment_type } = req.body;
  const file = req.file;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!file) return res.status(400).json({ error: 'Proof image required' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const proofPath = `/uploads/${file.filename}`;
  const { data, error } = await supabase.from('deposit_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone: phone || null, payment_type, proof_path: proofPath
  }).select().single();
  if (error) { console.error('Deposit insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.depositInitiated(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: payment_type });
  res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB via ${payment_type} submitted.` });
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('deposit_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('deposit_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('deposit_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), providerRef: reqData.id.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.payment_type || 'unknown' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('deposit_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositFailed(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ---------- WITHDRAWAL (unchanged) ----------
app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { amount, phone, withdrawal_type, name } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(withdrawal_type)) return res.status(400).json({ error: 'Invalid withdrawal type' });
  const receiver = (phone || '').trim();
  if (!receiver || receiver.length < 10) return res.status(400).json({ error: 'Valid receiver phone/account required' });
  const receiverName = (name || '').trim();
  if (!receiverName) return res.status(400).json({ error: 'Account holder name is required' });
  const user = await loadUser(userId, null);
  if (!user || user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  const { data, error } = await supabase.from('withdrawal_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone_number: receiver, withdrawal_type, receiver_name: receiverName
  }).select().single();
  if (error) { console.error('Withdraw insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.withdrawalRequested(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: withdrawal_type, receiver, name: receiverName });
  res.json({ success: true, requestId: data.id, message: `Withdrawal request of ${amt} ETB via ${withdrawal_type} to ${receiver} submitted.` });
});

app.get('/admin/withdrawals', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('withdrawal_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('withdrawal_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
    user.balance -= reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.withdrawal_type || 'N/A', receiver: reqData.phone_number });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalRejected(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ---------- AUDIT ENDPOINTS (unchanged) ----------
app.get('/admin/audit', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  const { roomId, userId, eventType, from, to, limit = 200 } = req.query;
  let query = supabase.from('audit_logs').select('*', { count: 'exact' });
  if (roomId) query = query.eq('room_id', roomId);
  if (userId) query = query.eq('user_id', userId);
  if (eventType) query = query.eq('event_type', eventType);
  if (from) query = query.gte('timestamp', from);
  if (to) query = query.lte('timestamp', to);
  query = query.order('timestamp', { ascending: false }).limit(Math.min(parseInt(limit), 1000));
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, logs: data, count });
});

app.get('/admin/audit-summary', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  try {
    const { data: deposits, error: depErr } = await supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    if (depErr) throw depErr;
    const { data: withdrawals, error: wdErr } = await supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    if (wdErr) throw wdErr;
    const { data: rounds, error: rdErr } = await supabase.from('game_rounds').select('house_profit');
    if (rdErr) throw rdErr;
    const totalDeposits = deposits.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalWithdrawals = withdrawals.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);
    res.json({ success: true, totalDeposits, totalWithdrawals, totalHouseProfit });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------- Socket.IO ----------
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
    socket.emit('lobbyState', { startsIn: timeLeft, takenNumbers: Array.from(currentGame.takenCardNumbers), playersCount: currentGame.players.length });
  } else if (currentGame.status === 'running') {
    socket.emit('gameStarted', { prizePool: currentGame.prizePool, playersCount: currentGame.players.length });
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (player) {
      socket.emit('yourCard', player.card);
      socket.emit('markedNumbers', player.markedNumbers);
      socket.emit('calledNumbers', currentGame.calledNumbers);
    }
  }

  socket.on('selectCardNumber', (cardNumber) => {
    if (currentGame.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentGame.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${currentGame.entryFee} birr.`);
      return;
    }
    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (currentGame.takenCardNumbers.has(num)) { socket.emit('cardSelectionFailed', 'This number is already taken.'); return; }
    const existing = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existing) { currentGame.takenCardNumbers.delete(existing.cardNumber); currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId); }
    currentGame.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: currentGame.cardSet[num - 1], markedNumbers: [], cardNumber: num, ip: ip };
    currentGame.players.push(player);
    Audit.cardAssigned('global', socket.userId, ip, { cardId: num.toString(), grid: player.card });
    io.emit('cardTaken', { number: num, takenNumbers: Array.from(currentGame.takenCardNumbers) });
    io.emit('playersCount', currentGame.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('newCardNumber', () => {
    if (currentGame.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentGame.entryFee) { socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${currentGame.entryFee} birr.`); return; }
    const freeNumbers = []; for (let i = 1; i <= 100; i++) if (!currentGame.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) { socket.emit('cardSelectionFailed', 'All numbers are taken.'); return; }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existing = currentGame.players.find(p => p.telegramId === socket.userId);
    if (existing) { currentGame.takenCardNumbers.delete(existing.cardNumber); currentGame.players = currentGame.players.filter(p => p.telegramId !== socket.userId); }
    currentGame.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: currentGame.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum, ip: ip };
    currentGame.players.push(player);
    Audit.cardAssigned('global', socket.userId, ip, { cardId: randomNum.toString(), grid: player.card });
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
    const flat = player.card.flat();
    if (!flat.includes(number)) return;
    if (!currentGame.calledNumbers.includes(num) && number !== 'FREE') return;
    if (player.markedNumbers.includes(number)) return;
    player.markedNumbers.push(number);
    socket.emit('markedNumbers', player.markedNumbers);
  });

  // ---------- Bingo claim with winning number storage ----------
  socket.on('claimBingo', () => {
    if (currentGame.status !== 'running') return;
    const player = currentGame.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const lastCalled = currentGame.calledNumbers.length > 0 ? currentGame.calledNumbers[currentGame.calledNumbers.length - 1] : null;
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (lastCalled === null || !isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      socket.emit('invalidBingo');
      Audit.bingoRejected('global', socket.userId, ip, { reason: 'invalid_bingo_call', lastCalled });
      return;
    }
    if (currentGame.winners.find(w => w.telegramId === socket.userId)) return;
    // 👇 Store the winning number (the last called number) if not already set
    if (currentGame.winningNumber === null) {
      currentGame.winningNumber = lastCalled;
    }
    currentGame.winners.push({ telegramId: socket.userId, username: socket.username });
    Audit.bingoCalled('global', socket.userId, ip, { cardId: player.cardNumber.toString(), cardGrid: player.card, calledNumber: lastCalled, winType: 'bingo_line' });
    socket.emit('bingoValid');
    if (!currentGame.bingoGraceTimeout && currentGame.winners.length === 1) {
      io.emit('multipleBingoPossible', { message: 'Bingo claimed! Waiting for other potential winners...' });
      currentGame.bingoGraceTimeout = setTimeout(() => { endGameWithWinners(); }, 3000);
    }
  });

  socket.on('getBalance', async () => { const u = await loadUser(socket.userId, socket.username); socket.emit('balanceUpdate', u.balance); });
});

app.use((err, req, res, next) => { console.error('Unhandled error:', err.message); res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });

resetGame();
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ---------- Supabase client (service role for full access) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Telegram initData validation ----------
function validateTelegramData(initData) {
  const data = Object.fromEntries(new URLSearchParams(initData));
  const { hash, ...dataWithoutHash } = data;
  const dataCheckString = Object.keys(dataWithoutHash)
    .sort()
    .map(key => `${key}=${dataWithoutHash[key]}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return calculatedHash === hash ? data : null;
}

// ---------- Bingo card generation ----------
function generateCard() {
  const columns = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
    [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
    [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75]
  ];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const columnNumbers = [];
    const available = [...columns[col]];
    for (let row = 0; row < 5; row++) {
      if (col === 2 && row === 2) {
        columnNumbers.push('FREE');
      } else {
        const idx = Math.floor(Math.random() * available.length);
        columnNumbers.push(available.splice(idx, 1)[0]);
      }
    }
    card.push(columnNumbers);
  }
  // transpose
  const transposed = [];
  for (let r = 0; r < 5; r++) {
    transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  }
  return transposed;
}

// ---------- Game management ----------
let currentGameId = null;
let callInterval = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startNewGame() {
  if (currentGameId) {
    await supabase
      .from('games')
      .update({ status: 'ended' })
      .eq('id', currentGameId);
  }

  const { data: newGame, error } = await supabase
    .from('games')
    .insert([{ status: 'lobby', start_time: new Date().toISOString() }])
    .select()
    .single();

  if (error) {
    console.error('Error starting new game:', error);
    return;
  }
  currentGameId = newGame.id;

  // Auto switch to running after 30 sec
  setTimeout(() => moveToRunning(), 30000);

  io.emit('lobbyStarted', { startsIn: 30 });
}

async function moveToRunning() {
  const { data: game, error } = await supabase
    .from('games')
    .select('*')
    .eq('id', currentGameId)
    .single();

  if (error || !game || game.status !== 'lobby') return;

  let players = game.players || [];
  if (players.length === 0) {
    await supabase.from('games').update({ status: 'ended' }).eq('id', currentGameId);
    startNewGame();
    return;
  }

  // Deduct entry fee
  for (const player of players) {
    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('telegram_id', player.telegramId)
      .single();

    if (!user || user.balance < game.entry_fee) {
      // Remove player if insufficient balance
      players = players.filter(p => p.telegramId !== player.telegramId);
      continue;
    }

    await supabase
      .from('users')
      .update({ balance: user.balance - game.entry_fee })
      .eq('telegram_id', player.telegramId);
  }

  if (players.length === 0) {
    await supabase.from('games').update({ status: 'ended' }).eq('id', currentGameId);
    startNewGame();
    return;
  }

  const prizePool = game.entry_fee * players.length;

  await supabase
    .from('games')
    .update({
      status: 'running',
      players,
      prize_pool: prizePool
    })
    .eq('id', currentGameId);

  io.emit('gameStarted');
  startCallingNumbers();
}

function startCallingNumbers() {
  if (callInterval) clearInterval(callInterval);
  callInterval = setInterval(callNextNumber, 4000);
}

async function callNextNumber() {
  const { data: game, error } = await supabase
    .from('games')
    .select('*')
    .eq('id', currentGameId)
    .single();

  if (error || !game || game.status !== 'running') {
    clearInterval(callInterval);
    return;
  }

  const allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  const called = game.called_numbers || [];
  const available = allNumbers.filter(n => !called.includes(n));
  if (available.length === 0) {
    endGame(null);
    return;
  }

  const number = available[Math.floor(Math.random() * available.length)];
  called.push(number);

  await supabase
    .from('games')
    .update({ called_numbers: called })
    .eq('id', currentGameId);

  io.emit('numberCalled', { number, calledNumbers: called });
}

async function endGame(winner) {
  clearInterval(callInterval);

  const { data: game } = await supabase
    .from('games')
    .select('*')
    .eq('id', currentGameId)
    .single();

  if (!game || game.status === 'ended') return;

  const updateData = { status: 'ended' };
  if (winner) {
    updateData.winner = winner;

    // Pay prize
    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('telegram_id', winner.telegramId)
      .single();

    if (user) {
      await supabase
        .from('users')
        .update({ balance: user.balance + game.prize_pool })
        .eq('telegram_id', winner.telegramId);
    }
  }

  await supabase
    .from('games')
    .update(updateData)
    .eq('id', currentGameId);

  io.emit('gameEnded', winner ? { winner } : { noWinner: true });

  setTimeout(() => startNewGame(), 5000);
}

function checkBingo(playerCard, markedNumbers) {
  const cardWithFree = playerCard.map(row =>
    row.map(cell => (cell === 'FREE' ? 'FREE' : cell))
  );
  // Rows
  for (let r = 0; r < 5; r++) {
    if (cardWithFree[r].every(cell => cell === 'FREE' || markedNumbers.includes(cell)))
      return true;
  }
  // Columns
  for (let c = 0; c < 5; c++) {
    let colBingo = true;
    for (let r = 0; r < 5; r++) {
      const val = cardWithFree[r][c];
      if (val !== 'FREE' && !markedNumbers.includes(val)) {
        colBingo = false;
        break;
      }
    }
    if (colBingo) return true;
  }
  // Diagonal top-left to bottom-right
  let diag1 = true;
  for (let i = 0; i < 5; i++) {
    const val = cardWithFree[i][i];
    if (val !== 'FREE' && !markedNumbers.includes(val)) {
      diag1 = false;
      break;
    }
  }
  if (diag1) return true;
  // Diagonal top-right to bottom-left
  let diag2 = true;
  for (let i = 0; i < 5; i++) {
    const val = cardWithFree[i][4 - i];
    if (val !== 'FREE' && !markedNumbers.includes(val)) {
      diag2 = false;
      break;
    }
  }
  return diag2;
}

// ---------- Socket.IO authentication and events ----------
io.use(async (socket, next) => {
  const initData = socket.handshake.query.initData;
  if (!initData) return next(new Error('No initData'));
  const validData = validateTelegramData(initData);
  if (!validData) return next(new Error('Invalid Telegram data'));
  const user = JSON.parse(validData.user);

  // Upsert user in Supabase (existence check + create)
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', user.id)
    .single();

  if (!existing) {
    await supabase.from('users').insert([
      { telegram_id: user.id, username: user.first_name, balance: 0 }
    ]);
  }

  socket.telegramId = user.id;
  socket.username = user.first_name;
  next();
});

io.on('connection', async (socket) => {
  // Get current game
  const { data: game } = await supabase
    .from('games')
    .select('*')
    .eq('id', currentGameId)
    .single();

  if (!game) {
    await startNewGame();
    socket.emit('lobbyState', { startsIn: 30 });
  } else {
    if (game.status === 'lobby') {
      const timeLeft = Math.max(
        0,
        (new Date(game.start_time).getTime() + 30000 - Date.now()) / 1000
      );
      socket.emit('lobbyState', { startsIn: Math.ceil(timeLeft) });

      // Add player if not already there
      let players = game.players || [];
      if (!players.find(p => p.telegramId === socket.telegramId)) {
        players.push({
          telegramId: socket.telegramId,
          username: socket.username,
          card: generateCard(),
          markedNumbers: []
        });
        await supabase
          .from('games')
          .update({ players })
          .eq('id', currentGameId);
      }
    } else if (game.status === 'running') {
      socket.emit('gameStarted');
      const player = (game.players || []).find(
        p => p.telegramId === socket.telegramId
      );
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('calledNumbers', game.called_numbers);
        socket.emit('markedNumbers', player.markedNumbers || []);
      }
    }
  }

  // New card (lobby)
  socket.on('newCard', async () => {
    const { data: current } = await supabase
      .from('games')
      .select('*')
      .eq('id', currentGameId)
      .single();
    if (!current || current.status !== 'lobby') return;
    let players = current.players || [];
    const idx = players.findIndex(p => p.telegramId === socket.telegramId);
    if (idx === -1) return;
    players[idx].card = generateCard();
    await supabase.from('games').update({ players }).eq('id', currentGameId);
    socket.emit('yourCard', players[idx].card);
  });

  // Mark number (game)
  socket.on('markNumber', async (number) => {
    const { data: current } = await supabase
      .from('games')
      .select('*')
      .eq('id', currentGameId)
      .single();
    if (!current || current.status !== 'running') return;
    if (!(current.called_numbers || []).includes(number)) return;

    let players = current.players || [];
    const idx = players.findIndex(p => p.telegramId === socket.telegramId);
    if (idx === -1) return;
    const player = players[idx];
    const flatCard = player.card.flat().filter(c => c !== 'FREE');
    if (!flatCard.includes(number)) return;

    const marked = player.markedNumbers || [];
    if (!marked.includes(number)) {
      marked.push(number);
      players[idx].markedNumbers = marked;
      await supabase.from('games').update({ players }).eq('id', currentGameId);
      socket.emit('markedNumbers', marked);
    }
  });

  // Bingo claim
  socket.on('claimBingo', async () => {
    const { data: current } = await supabase
      .from('games')
      .select('*')
      .eq('id', currentGameId)
      .single();
    if (!current || current.status !== 'running') return;

    const player = (current.players || []).find(
      p => p.telegramId === socket.telegramId
    );
    if (!player) return;

    if (checkBingo(player.card, player.markedNumbers || [])) {
      await endGame({
        telegramId: player.telegramId,
        username: player.username
      });
    } else {
      socket.emit('invalidBingo');
    }
  });

  // Balance request
  socket.on('getBalance', async () => {
    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('telegram_id', socket.telegramId)
      .single();
    socket.emit('balance', user ? user.balance : 0);
  });

  socket.on('disconnect', () => {});
});

// ---------- REST endpoints ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin add balance
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  if (!telegramId || !amount || amount <= 0)
    return res.status(400).json({ error: 'Invalid data' });

  // Upsert: if user doesn't exist, create with that telegram_id
  const { data: user } = await supabase
    .from('users')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (user) {
    await supabase
      .from('users')
      .update({ balance: user.balance + amount })
      .eq('telegram_id', telegramId);
  } else {
    await supabase.from('users').insert([
      { telegram_id: telegramId, balance: amount, username: 'unknown' }
    ]);
  }

  res.json({ success: true });
});

// Serve the HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await startNewGame();
});
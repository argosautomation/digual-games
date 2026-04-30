const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io'
});

app.use(express.static('public'));
app.use(express.json());

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
});

const FALLBACK = {
  kids: [
    "What's the best superpower and why?",
    "If your pet could talk, what would they say first?",
    "What makes the perfect pizza?",
    "What's the funniest thing a teacher could say?",
    "If your bed could fly, where would you go?",
    "What would you do if you were invisible for a day?",
  ],
  teens: [
    "The most embarrassing thing to happen at school",
    "What's the most overrated thing ever?",
    "The worst advice someone could give you",
    "What would make the worst TikTok trend?",
    "The best excuse for being late to class",
    "What's something everyone pretends to like but secretly hates?",
  ],
  adults: [
    "The worst thing to hear at a job interview",
    "A sentence you never want to hear from your doctor",
    "The most useless invention ever created",
    "What's the worst thing your neighbor could do?",
    "The best way to ruin a first date",
    "The worst thing to see in your coworker's fridge",
  ],
};

const EMOJIS = ['\u{1F355}','\u{1F3AE}','\u{1F680}','\u{1F308}','\u{1F984}','\u{1F37F}','\u{1F3B8}','\u{1F32E}','\u{1F431}','\u{1F3AA}','\u{1F340}','\u{1F98A}','\u{1F3AF}','\u{1F369}','\u{1F409}','\u{1F3A8}','\u26A1','\u{1F981}','\u{1F354}','\u{1F3B2}','\u{1F31F}','\u{1F427}','\u{1F3AD}','\u{1F36A}','\u{1F98B}','\u{1F3A4}','\u{1F33A}','\u{1F438}','\u{1F3B0}','\u{1F347}'];
const WORDS = ['PLAY','FUN','GAME','QUIP','LAFF','JOKE','WITZ','ZING','BOLT','FIRE','STAR','MOON','CLUB','ACE','KING','JEST','WAVE','TALE','CHAT','BUZZ'];

function randCode() { return WORDS[Math.floor(Math.random() * WORDS.length)]; }
function pickEmojis(n) { const s = [...EMOJIS].sort(() => Math.random() - 0.5); return s.slice(0, n || 4); }
function shuffle(a) { const s = [...a]; for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; } return s; }

const rooms = {};

app.get('/api/qr', async (req, res) => {
  const room = req.query.room || '';
  if (!room) return res.status(400).json({ error: 'room required' });
  try {
    const url = 'https://digual.com/games/?join=' + room;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 300, color: { dark: '#00f2ea', light: '#0f0c29' } });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.json({ exists: false });
  res.json({ exists: true, playerCount: room.players.length, state: room.state });
});

async function genPrompts(age, theme, count) {
  if (openai.apiKey) {
    try {
      const th = theme === 'mixed' ? 'any theme (sports, entertainment, pirates, food, animals, school, work, etc.)' : theme + ' theme';
      const ad = age === 'kids' ? 'family-friendly, G-rated, for children' : age === 'teens' ? 'PG-13, for teenagers' : 'adult humor, edgy and risque';
      const r = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Generate funny party game prompts. Return ONLY a JSON array of strings.' },
          { role: 'user', content: 'Generate ' + count + ' funny quippy prompts for Quiplash. Age: ' + age + ' (' + ad + '). Theme: ' + th + '. Each is a short sentence/question under 30 words for witty one-line answers. Return JSON array of strings.' }
        ],
        temperature: 0.9, max_tokens: 2000,
      });
      const t = r.choices[0].message.content.trim();
      const m = t.match(/\[[\s\S]*\]/);
      if (m) { const p = JSON.parse(m[0]); if (Array.isArray(p) && p.length > 0) return p; }
    } catch (e) { console.error('AI failed:', e.message); }
  }
  const pool = FALLBACK[age] || FALLBACK.adults;
  const sh = shuffle(pool);
  const res = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) res.push(sh[i]);
  while (res.length < count) res.push(res[res.length % pool.length]);
  return res;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', async ({ hostName, ageRange, theme }, cb) => {
    try {
      const code = randCode();
      const emojis = pickEmojis(4);
      rooms[code] = {
        code, host: socket.id, hostName: hostName || 'Host', ageRange: ageRange || 'adults',
        theme: theme || 'mixed', emojis, players: [], state: 'lobby', currentRound: 0,
        maxRounds: 3, prompts: [], votes: {}, roundResults: [],
      };
      currentRoom = code;
      socket.join(code);
      rooms[code].players.push({ id: socket.id, name: hostName || 'Host', emoji: '\u{1F451}', isHost: true, isAudience: false, score: 0 });
      cb({ success: true, roomCode: code, emojis });
      broadcast(code);
    } catch (e) { cb({ success: false, error: e.message }); }
  });

  socket.on('join_room', ({ roomCode, playerName, isAudience }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.state !== 'lobby') return cb({ success: false, error: 'Game already started' });
    const active = room.players.filter(p => !p.isAudience);
    const forced = isAudience || active.length >= 8;
    const p = { id: socket.id, name: playerName || 'Anonymous', emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], isHost: false, isAudience: forced, score: 0 };
    room.players.push(p);
    currentRoom = roomCode;
    socket.join(roomCode);
    cb({ success: true, player: p, room: { code: room.code, emojis: room.emojis, hostName: room.hostName, ageRange: room.ageRange, theme: room.theme, state: room.state, players: room.players.map(x => ({ name: x.name, emoji: x.emoji, isHost: x.isHost, isAudience: x.isAudience })) } });
    broadcast(roomCode);
  });

  socket.on('start_game', async (cb) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return cb?.({ success: false, error: 'Only host' });
    const active = room.players.filter(p => !p.isAudience);
    if (active.length < 2) return cb?.({ success: false, error: 'Need 2+ active players' });
    room.currentRound = 1;
    room.state = 'answering';
    room.votes = {};
    room.prompts = [];
    const total = active.length * 2;
    const raw = await genPrompts(room.ageRange, room.theme, total);
    let idx = 0;
    for (const pl of active) {
      for (let i = 0; i < 2; i++) {
        room.prompts.push({ id: 'p_' + idx + '_' + Date.now(), text: raw[idx % raw.length], playerId: pl.id, answer: null });
        idx++;
      }
    }
    for (const pl of active) {
      const mine = room.prompts.filter(p => p.playerId === pl.id);
      io.to(pl.id).emit('your_prompts', { prompts: mine.map(p => ({ id: p.id, text: p.text })) });
    }
    broadcast(room.code);
    cb?.({ success: true });
  });

  socket.on('submit_answer', ({ promptId, answer }, cb) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const p = room.prompts.find(x => x.id === promptId);
    if (p && p.playerId === socket.id && !p.answer) p.answer = answer;
    if (room.prompts.every(x => x.answer !== null)) room.state = 'voting';
    broadcast(room.code);
    cb?.({ success: true });
  });

  socket.on('submit_vote', ({ promptId }, cb) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'voting') return cb?.({ success: false, error: 'Not voting' });
    const p = room.prompts.find(x => x.id === promptId);
    if (!p) return cb?.({ success: false, error: 'Not found' });
    if (p.playerId === socket.id) return cb?.({ success: false, error: 'Cannot vote own' });
    if (!room.votes[socket.id]) room.votes[socket.id] = [];
    if (room.votes[socket.id].includes(promptId)) return cb?.({ success: false, error: 'Already voted' });
    room.votes[socket.id].push(promptId);
    const total = Object.values(room.votes).reduce((s, a) => s + a.length, 0);
    if (total >= room.players.length * 2) { tally(room); room.state = 'results'; }
    broadcast(room.code);
    cb?.({ success: true });
  });

  socket.on('next_round', async (cb) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;
    if (room.currentRound >= room.maxRounds) { room.state = 'finished'; broadcast(room.code); return; }
    room.currentRound++;
    room.state = 'answering';
    room.votes = {};
    room.prompts = [];
    const active = room.players.filter(p => !p.isAudience);
    const total = active.length * 2;
    const raw = await genPrompts(room.ageRange, room.theme, total);
    let idx = 0;
    for (const pl of active) {
      for (let i = 0; i < 2; i++) {
        room.prompts.push({ id: 'p_' + idx + '_' + Date.now(), text: raw[idx % raw.length], playerId: pl.id, answer: null });
        idx++;
      }
    }
    for (const pl of active) {
      const mine = room.prompts.filter(p => p.playerId === pl.id);
      io.to(pl.id).emit('your_prompts', { prompts: mine.map(p => ({ id: p.id, text: p.text })) });
    }
    broadcast(room.code);
    cb?.({ success: true });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.host === socket.id && room.players.length > 0) {
        room.host = room.players[0].id;
        room.players[0].isHost = true;
        room.hostName = room.players[0].name;
      }
      if (room.players.length === 0) delete rooms[currentRoom];
      else broadcast(room.code);
    }
  });

  function broadcast(code) {
    const room = rooms[code];
    if (!room) return;
    const vc = {};
    for (const [vid, votes] of Object.entries(room.votes)) for (const pid of votes) vc[pid] = (vc[pid] || 0) + 1;
    const state = {
      code: room.code, hostName: room.hostName, ageRange: room.ageRange, theme: room.theme,
      emojis: room.emojis, state: room.state, currentRound: room.currentRound, maxRounds: room.maxRounds,
      players: room.players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, isHost: p.isHost, isAudience: p.isAudience, score: p.score })),
      promptsForDisplay: (room.state === 'voting' || room.state === 'results') ? room.prompts.filter(p => p.answer).map(p => ({ id: p.id, text: p.text, answer: p.answer, playerId: p.playerId })) : [],
      roundResults: room.roundResults,
      voteCounts: vc,
    };
    io.to(code).emit('game_state', state);
  }

  function tally(room) {
    const vc = {};
    for (const [vid, votes] of Object.entries(room.votes)) for (const pid of votes) vc[pid] = (vc[pid] || 0) + 1;
    for (const [pid, votes] of Object.entries(vc)) {
      const p = room.prompts.find(x => x.id === pid);
      if (p) { const pl = room.players.find(x => x.id === p.playerId); if (pl && !pl.isAudience) pl.score += votes; }
    }
    const rs = {};
    for (const p of room.prompts) {
      if (p.answer) {
        const pl = room.players.find(x => x.id === p.playerId);
        if (pl && !pl.isAudience) {
          if (!rs[p.playerId]) rs[p.playerId] = { name: pl.name, emoji: pl.emoji, totalVotes: 0, totalScore: pl.score };
          rs[p.playerId].totalVotes += vc[p.id] || 0;
        }
      }
    }
    room.roundResults.push({
      round: room.currentRound,
      prompts: room.prompts.filter(p => p.answer).map(p => ({ text: p.text, answer: p.answer, playerName: (room.players.find(pl => pl.id === p.playerId) || {}).name || 'Unknown', votes: vc[p.id] || 0 })),
      scores: Object.entries(rs).map(([id, s]) => ({ id, ...s })).sort((a, b) => b.totalVotes - a.totalVotes),
    });
  }
});

server.listen(3201, '127.0.0.1', () => {
  console.log('Digual Games running on port 3200');
});
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3201;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://digual.com/games';
const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const ANSWER_MS = parseInt(process.env.ANSWER_MS, 10) || 75 * 1000;
const VOTE_MS = parseInt(process.env.VOTE_MS, 10) || 30 * 1000;
const RECONNECT_GRACE_MS = 90 * 1000;
// Comma-separated list of allowed origins for Socket.IO. In dev, fall back to *.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[startup] Invalid PORT:', process.env.PORT);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*' },
  path: '/socket.io',
});

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(PUBLIC_DIR, {
  // Always revalidate index.html so players get fresh JS after a deploy
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use(express.json());

const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY || '' });
const HAS_AI = !!process.env.DEEPSEEK_API_KEY;
if (!HAS_AI) console.warn('[startup] DEEPSEEK_API_KEY not set — using built-in fallback prompts only');

// ============== Prompt pools ==============

const FALLBACK = {
  kids: [
    "What's the best superpower and why?",
    "If your pet could talk, what would they say first?",
    "What makes the perfect pizza?",
    "What's the funniest thing a teacher could say?",
    "If your bed could fly, where would you go?",
    "What would you do if you were invisible for a day?",
    "The worst flavor of ice cream ever invented",
    "What does a dinosaur do on its day off?",
    "If you ran a zoo, what's the weirdest animal you'd add?",
    "What would happen if homework was illegal?",
    "The strangest thing to find under your bed",
    "If a robot made your lunch, what would it pack?",
    "The best name for a new color",
    "What's a terrible name for a new candy?",
    "What would your dog say if it could text?",
    "What's the funniest sound an alien could make?",
  ],
  teens: [
    "The most embarrassing thing to happen at school",
    "What's the most overrated thing ever?",
    "The worst advice someone could give you",
    "What would make the worst TikTok trend?",
    "The best excuse for being late to class",
    "What's something everyone pretends to like but secretly hates?",
    "The worst possible class to add to a school schedule",
    "Something you should never say on a first date",
    "An honest tagline for high school",
    "The worst superpower to have at school",
    "A reality TV show that absolutely should not exist",
    "What's the dumbest thing trending right now?",
    "The worst thing to say in a college interview",
    "An unfortunate username someone might pick",
    "The most cringe text a parent could send",
    "What would be on the menu at the world's worst restaurant?",
  ],
  adults: [
    "The worst thing to hear at a job interview",
    "A sentence you never want to hear from your doctor",
    "The most useless invention ever created",
    "What's the worst thing your neighbor could do?",
    "The best way to ruin a first date",
    "The worst thing to see in your coworker's fridge",
    "An honest slogan for your hometown",
    "A bad name for a cologne",
    "What you'd find in the world's worst gift shop",
    "A terrible thing to say at a wedding",
    "A surprising thing to find in your boss's desk",
    "An app no one asked for",
    "The least helpful piece of life advice",
    "What's the worst possible reason for getting fired?",
    "A dating profile bio that guarantees zero matches",
    "An unfortunate side effect from a new medication",
  ],
};

const THEME_DESC = {
  mixed: 'any theme (sports, entertainment, animals, school, work, travel, food, etc.)',
  derby: 'Kentucky Derby and horse racing — mint juleps, big floppy hats, "Run for the Roses", Churchill Downs, jockeys, betting tickets, bourbon, fancy southern attire, the infield, photo finishes, garlands of roses, bugle calls',
  sports: 'sports and athletics',
  entertainment: 'movies, TV shows, celebrities, and pop culture',
  pirates: 'pirates, the high seas, treasure, parrots, and naval mischief',
  food: 'food, cooking, restaurants, and snacks',
  music: 'music, concerts, instruments, bands, and lyrics',
  animals: 'animals, pets, the zoo, and the wild',
  travel: 'travel, vacations, airports, hotels, and tourist traps',
  office: 'office life, meetings, coworkers, email, and corporate culture',
};

const THEME_FALLBACK = {
  derby: [
    "What's the worst thing to overhear in the betting line at Churchill Downs?",
    'A terrible name for a racehorse',
    'The most embarrassing thing to wear to a Derby party',
    "What's the bartender's secret ingredient in this mint julep?",
    'A bad pickup line to use in the infield at the Derby',
    "What's a jockey muttering to their horse at the starting gate?",
    'The worst possible halftime show for the Kentucky Derby',
    'An unfortunate slogan for a new bourbon brand',
    "What's the loudest thing a Derby hat can say without words?",
    'A reason your horse just lost the Derby by a nose',
    'Something you should never yell at the track announcer',
    'The most southern way to congratulate a winner',
    'A new event they should add at Churchill Downs',
    'What does a horse text its trainer the night before the race?',
    'The strangest thing to bring as your Derby party "+1"',
    "An honest tagline for the world's saddest racehorse",
  ],
};

const SAFETY_QUIPS = [
  '🤐 [the silent type]',
  '🤷 …',
  'I plead the fifth',
  '[gone for a refill]',
  'Pass.',
  '[my phone died]',
  '…crickets…',
  '(left the chat)',
  'Same as the last one.',
  'Ask me again later.',
];
function pickQuip() { return SAFETY_QUIPS[Math.floor(Math.random() * SAFETY_QUIPS.length)]; }

// ============== Helpers ==============

const EMOJIS = ['\u{1F355}','\u{1F3AE}','\u{1F680}','\u{1F308}','\u{1F984}','\u{1F37F}','\u{1F3B8}','\u{1F32E}','\u{1F431}','\u{1F3AA}','\u{1F340}','\u{1F98A}','\u{1F3AF}','\u{1F369}','\u{1F409}','\u{1F3A8}','⚡','\u{1F981}','\u{1F354}','\u{1F3B2}','\u{1F31F}','\u{1F427}','\u{1F3AD}','\u{1F36A}','\u{1F98B}','\u{1F3A4}','\u{1F33A}','\u{1F438}','\u{1F3B0}','\u{1F347}'];
const WORDS = ['PLAY','FUN','GAME','QUIP','LAFF','JOKE','WITZ','ZING','BOLT','FIRE','STAR','MOON','CLUB','ACE','KING','JEST','WAVE','TALE','CHAT','BUZZ'];

function pickEmojis(n) { const s = [...EMOJIS].sort(() => Math.random() - 0.5); return s.slice(0, n || 4); }
function shuffle(a) { const s = [...a]; for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; } return s; }
function uid() { return crypto.randomBytes(8).toString('hex'); }
function token() { return crypto.randomBytes(16).toString('hex'); }

const rooms = {};

function uniqueRoomCode() {
  const taken = new Set(Object.keys(rooms));
  for (let i = 0; i < 50; i++) {
    const c = WORDS[Math.floor(Math.random() * WORDS.length)] + (i > 19 ? Math.floor(Math.random() * 99) : '');
    if (!taken.has(c)) return c;
  }
  return 'R' + Date.now().toString(36).toUpperCase();
}

function findRoomByEmojis(emojis) {
  if (!Array.isArray(emojis) || emojis.length !== 4) return null;
  const target = emojis.join('');
  for (const r of Object.values(rooms)) if (r.emojis.join('') === target) return r;
  return null;
}

function gcRooms() {
  const now = Date.now();
  for (const [code, r] of Object.entries(rooms)) {
    if (now - r.lastActivity > ROOM_TTL_MS) {
      console.log('[gc] removing idle room', code);
      clearTimeout(r.phaseTimer);
      delete rooms[code];
    }
  }
}
setInterval(gcRooms, 1000 * 60 * 15);

function playerBySocket(room, sid) { return room.players.find(p => p.socketId === sid); }
function playerByToken(room, tok) { return room.players.find(p => p.token === tok); }
function activePlayers(room) { return room.players.filter(p => !p.isAudience && !p.removed); }
function visiblePlayers(room) { return room.players.filter(p => !p.removed); }
function isHostSocket(room, sid) { return room.hostSocketId === sid; }

// ============== HTTP ==============

app.get('/api/qr', async (req, res) => {
  const room = (req.query.room || '').toString().toUpperCase();
  if (!room) return res.status(400).json({ error: 'room required' });
  try {
    const url = PUBLIC_URL.replace(/\/$/, '') + '/?join=' + encodeURIComponent(room);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 300, color: { dark: '#1a1a1a', light: '#fff4d6' } });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get("/api/qr-png", async (req, res) => {
  const room = (req.query.room || "").toString().toUpperCase();
  if (!room) return res.status(400).json({ error: "room required" });
  try {
    const url = PUBLIC_URL.replace(/\/$/, "") + "/?join=" + encodeURIComponent(room);
    const buf = await QRCode.toBuffer(url, { type: "png", margin: 2, width: 300, color: { dark: "#1a1a1a", light: "#fff4d6" } });
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/room/:code', (req, res) => {
  const room = rooms[(req.params.code || '').toUpperCase()];
  if (!room) return res.json({ exists: false });
  res.json({ exists: true, playerCount: visiblePlayers(room).length, state: room.state });
});

app.get('/api/emojis', (req, res) => res.json({ emojis: EMOJIS }));

// ============== Roku REST API ==============

app.get('/api/roku/state/:roomCode', (req, res) => {
  const room = rooms[(req.params.roomCode || '').toUpperCase()];
  if (!room) return res.json({ error: 'Room not found', exists: false });
  res.json(buildStatePayload(room));
});

const VALID_AGE_RANGES = new Set(['kids', 'teens', 'adults']);
const VALID_THEMES = new Set(Object.keys(THEME_DESC));

function sanitizeName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  return s.replace(/[ -]/g, '').trim().slice(0, 20) || fallback;
}

app.post('/api/roku/create-room', (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const hostName = sanitizeName(body.hostName, 'Roku TV');
    const ageRange = VALID_AGE_RANGES.has(body.ageRange) ? body.ageRange : 'adults';
    const theme = VALID_THEMES.has(body.theme) ? body.theme : 'derby';
    const code = uniqueRoomCode();
    const emojis = pickEmojis(4);
    const hostTok = token();
    rooms[code] = {
      code,
      hostSocketId: null,
      hostToken: hostTok,
      hostName,
      ageRange,
      theme,
      emojis,
      players: [],
      state: 'lobby',
      currentRound: 0,
      maxRounds: 3,
      prompts: [],
      votes: {},
      roundResults: [],
      usedPromptTexts: [],
      lastActivity: Date.now(),
      phaseTimer: null,
      phaseEndsAt: null,
    };
    res.json({ success: true, roomCode: code, emojis, hostToken: hostTok });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/roku/action/:roomCode', async (req, res) => {
  const room = rooms[(req.params.roomCode || '').toUpperCase()];
  if (!room) return res.json({ success: false, error: 'Room not found' });
  const { token: hostToken, action } = req.body;
  if (room.hostToken !== hostToken) return res.json({ success: false, error: 'Unauthorized' });
  try {
    if (action === 'start_game') {
      const active = activePlayers(room);
      if (active.length < 3) return res.json({ success: false, error: 'Need 3+ players to start' });
      room.currentRound = 1;
      await startRound(room);
      return res.json({ success: true });
    } else if (action === 'next_round') {
      if (room.currentRound >= room.maxRounds) {
        room.state = 'finished';
        clearPhaseTimer(room);
        broadcast(room.code);
        return res.json({ success: true });
      }
      room.currentRound++;
      await startRound(room);
      return res.json({ success: true });
    } else if (action === 'force_advance') {
      if (room.state !== 'answering') return res.json({ success: false, error: 'Not answering' });
      endAnsweringPhase(room);
      return res.json({ success: true });
    } else if (action === 'force_results') {
      if (room.state !== 'voting') return res.json({ success: false, error: 'Not voting' });
      tally(room);
      room.state = 'results';
      clearPhaseTimer(room);
      broadcast(room.code);
      return res.json({ success: true });
    }
    return res.json({ success: false, error: 'Unknown action' });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ============== Prompt generation ==============

async function genPrompts(age, theme, count) {
  const themeText = THEME_DESC[theme] || (theme + ' theme');
  if (HAS_AI) {
    try {
      const th = theme === 'mixed' ? themeText : themeText + ' (stay strongly on this theme — most prompts should clearly evoke it)';
      const ad = age === 'kids' ? 'family-friendly, G-rated, for children' : age === 'teens' ? 'PG-13, for teenagers' : 'adult humor, edgy and risque';
      const r = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Generate funny party game prompts. Return ONLY a JSON array of strings.' },
          { role: 'user', content: `Generate ${count} funny quippy prompts for Quiplash. Age: ${age} (${ad}). Theme: ${th}. Each is a short sentence/question under 30 words for witty one-line answers. Return JSON array of strings.` },
        ],
        temperature: 0.9,
        max_tokens: 2000,
      });
      const t = r.choices[0].message.content.trim();
      const m = t.match(/\[[\s\S]*\]/);
      if (m) {
        const p = JSON.parse(m[0]);
        if (Array.isArray(p) && p.length >= count) return p.slice(0, count);
        if (Array.isArray(p) && p.length > 0) {
          const padded = [...p];
          const pool = FALLBACK[age] || FALLBACK.adults;
          const sh = shuffle(pool);
          let i = 0;
          while (padded.length < count) padded.push(sh[i++ % sh.length]);
          return padded;
        }
      }
    } catch (e) {
      console.error('AI prompt generation failed:', e.message);
    }
  }
  const themePool = THEME_FALLBACK[theme] || [];
  const agePool = FALLBACK[age] || FALLBACK.adults;
  const pool = themePool.length ? shuffle(themePool).concat(shuffle(agePool)) : shuffle(agePool);
  if (pool.length >= count) return pool.slice(0, count);
  const out = [...pool];
  let i = 0;
  while (out.length < count) out.push(pool[i++ % pool.length]);
  return out;
}

// ============== Round / phase machinery ==============

function clearPhaseTimer(room) {
  if (room.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
  room.phaseEndsAt = null;
}

function setPhaseTimer(room, ms, fn) {
  clearPhaseTimer(room);
  room.phaseStartedAt = Date.now();
  room.phaseEndsAt = Date.now() + ms;
  room.phaseTimer = setTimeout(fn, ms);
}

async function startRound(room) {
  room.state = 'answering';
  room.votes = {};
  room.prompts = [];
  room.lastActivity = Date.now();
  const isLastLash = room.currentRound === room.maxRounds;
  room.isLastLash = isLastLash;
  // Only assign prompts to players who are actually present — skip disconnected/phantom records
  const active = activePlayers(room).filter(p => !p.disconnected);
  // Pull prompts excluding any already used in this room. Generate extra to allow filtering.
  if (!Array.isArray(room.usedPromptTexts)) room.usedPromptTexts = [];
  async function freshPrompts(count) {
    const used = new Set(room.usedPromptTexts);
    const out = [];
    let attempts = 0;
    while (out.length < count && attempts < 3) {
      attempts++;
      const batch = await genPrompts(room.ageRange, room.theme, count + used.size + 4);
      for (const t of batch) {
        if (out.length >= count) break;
        if (used.has(t)) continue;
        used.add(t); out.push(t);
      }
    }
    if (out.length < count) {
      const pool = (FALLBACK[room.ageRange] || FALLBACK.adults).slice();
      for (const t of pool) {
        if (out.length >= count) break;
        if (used.has(t)) continue;
        used.add(t); out.push(t);
      }
      while (out.length < count) out.push(pool[out.length % pool.length]);
    }
    return out;
  }
  if (isLastLash) {
    // Final round: ONE shared prompt, every player answers it, votes count 2x
    const [text] = await freshPrompts(1);
    room.usedPromptTexts.push(text);
    for (const pl of active) {
      room.prompts.push({ id: 'p_' + uid(), text, playerId: pl.id, answer: null });
    }
  } else {
    const total = active.length * 2;
    const raw = await freshPrompts(total);
    for (const t of raw) room.usedPromptTexts.push(t);
    let idx = 0;
    for (const pl of active) {
      for (let i = 0; i < 2; i++) {
        room.prompts.push({ id: 'p_' + uid(), text: raw[idx % raw.length], playerId: pl.id, answer: null });
        idx++;
      }
    }
  }
  for (const pl of active) {
    const mine = room.prompts.filter(p => p.playerId === pl.id);
    if (pl.socketId) io.to(pl.socketId).emit('your_prompts', { prompts: mine.map(p => ({ id: p.id, text: p.text })) });
  }
  setPhaseTimer(room, ANSWER_MS, () => endAnsweringPhase(room));
  broadcast(room.code);
}

function endAnsweringPhase(room) {
  if (!rooms[room.code] || room.state !== 'answering') return;
  let safetyCount = 0;
  for (const p of room.prompts) {
    if (!p.answer) { p.answer = pickQuip(); safetyCount++; }
  }
  if (safetyCount) console.log(`[room ${room.code}] auto-filled ${safetyCount} answer(s)`);
  room.state = 'voting';
  setPhaseTimer(room, VOTE_MS, () => endVotingPhase(room));
  broadcast(room.code);
}

function endVotingPhase(room) {
  if (!rooms[room.code] || room.state !== 'voting') return;
  tally(room);
  room.state = 'results';
  clearPhaseTimer(room);
  broadcast(room.code);
}

function votingComplete(room) {
  const voters = visiblePlayers(room);
  if (voters.length === 0) return false;
  for (const v of voters) {
    if (v.disconnected) continue;
    // Don't block completion on audience members who joined after this voting phase started
    if (room.phaseStartedAt && v.joinedAt && v.joinedAt > room.phaseStartedAt) continue;
    const own = room.prompts.filter(p => p.playerId === v.id).length;
    const eligible = room.prompts.filter(p => p.answer).length - own;
    // Non-LastLash: head-to-head pairs (one vote per other player's pair).
    // LastLash: one shared prompt, vote on each non-self answer (capped at 2 for sanity).
    const cap = room.isLastLash ? Math.min(2, eligible) : Math.floor(eligible / 2);
    if (cap <= 0) continue;
    const cast = (room.votes[v.id] || []).length;
    if (cast < cap) return false;
  }
  return true;
}

function tally(room) {
  const multiplier = room.isLastLash ? 2 : 1;
  const vc = {};
  for (const votes of Object.values(room.votes)) for (const pid of votes) vc[pid] = (vc[pid] || 0) + 1;
  for (const [pid, votes] of Object.entries(vc)) {
    const p = room.prompts.find(x => x.id === pid);
    if (!p) continue;
    const pl = room.players.find(x => x.id === p.playerId);
    if (pl && !pl.isAudience) pl.score += votes * multiplier;
  }
  const rs = {};
  for (const p of room.prompts) {
    if (!p.answer) continue;
    const pl = room.players.find(x => x.id === p.playerId);
    if (!pl || pl.isAudience) continue;
    if (!rs[p.playerId]) rs[p.playerId] = { name: pl.name, emoji: pl.emoji, totalVotes: 0, totalScore: pl.score };
    rs[p.playerId].totalVotes += vc[p.id] || 0;
  }
  room.roundResults.push({
    round: room.currentRound,
    isLastLash: !!room.isLastLash,
    multiplier,
    prompts: room.prompts.filter(p => p.answer).map(p => {
      const pl = room.players.find(pl => pl.id === p.playerId);
      return { text: p.text, answer: p.answer, playerName: (pl && pl.name) || 'Unknown', votes: (vc[p.id] || 0) * multiplier };
    }),
    scores: Object.entries(rs).map(([id, s]) => ({ id, ...s, totalVotes: s.totalVotes * multiplier })).sort((a, b) => b.totalVotes - a.totalVotes),
  });
}

function buildStatePayload(room) {
  const vc = {};
  for (const votes of Object.values(room.votes)) for (const pid of votes) vc[pid] = (vc[pid] || 0) + 1;
  const active = activePlayers(room);
  // Total expected answers should reflect only players who actually got prompts assigned —
  // disconnected players are skipped at startRound time, so don't count them here either.
  const promptedCount = (room.state === 'answering' || room.state === 'voting' || room.state === 'results')
    ? new Set(room.prompts.map(p => p.playerId)).size
    : active.filter(p => !p.disconnected).length;
  const totalAnswers = room.isLastLash ? promptedCount : promptedCount * 2;
  const answeredCount = room.prompts.filter(p => p.answer).length;
  return {
    code: room.code,
    hostName: room.hostName,
    ageRange: room.ageRange,
    theme: room.theme,
    emojis: room.emojis,
    state: room.state,
    currentRound: room.currentRound,
    maxRounds: room.maxRounds,
    isLastLash: !!room.isLastLash,
    phaseEndsAt: room.phaseEndsAt,
    players: visiblePlayers(room).map(p => ({
      id: p.id, name: p.name, emoji: p.emoji, isHost: p.isHost, isAudience: p.isAudience,
      score: p.score, disconnected: !!p.disconnected,
    })),
    promptsForDisplay: (room.state === 'voting' || room.state === 'results')
      ? room.prompts.filter(p => p.answer).map(p => ({ id: p.id, text: p.text, answer: p.answer, playerId: p.playerId }))
      : [],
    answeredCount,
    totalAnswers,
    roundResults: room.roundResults,
    voteCounts: vc,
  };
}

function broadcast(code) {
  const room = rooms[code];
  if (!room) return;
  room.lastActivity = Date.now();
  io.to(code).emit('game_state', buildStatePayload(room));
}

function snapshotForPlayer(room, player) {
  const mine = room.prompts.filter(p => p.playerId === player.id);
  return { prompts: mine.map(p => ({ id: p.id, text: p.text, answer: p.answer })) };
}

// ============== Sockets ==============

io.on('connection', (socket) => {
  let currentRoom = null;

  function joinChannel(code) {
    currentRoom = code;
    socket.join(code);
  }

  socket.on('create_room', async ({ hostName, ageRange, theme }, cb) => {
    try {
      const code = uniqueRoomCode();
      const emojis = pickEmojis(4);
      const hostTok = token();
      rooms[code] = {
        code,
        hostSocketId: socket.id,
        hostToken: hostTok,
        hostName: hostName || 'Host',
        ageRange: ageRange || 'adults',
        theme: theme || 'mixed',
        emojis,
        players: [],
        state: 'lobby',
        currentRound: 0,
        maxRounds: 3,
        prompts: [],
        votes: {},
        roundResults: [],
        usedPromptTexts: [],
        lastActivity: Date.now(),
        phaseTimer: null,
        phaseEndsAt: null,
      };
      joinChannel(code);
      cb && cb({ success: true, roomCode: code, emojis, hostToken: hostTok });
      broadcast(code);
    } catch (e) {
      cb && cb({ success: false, error: e.message });
    }
  });

  function tryJoin(room, playerName, isAudience, cb) {
    if (!room) return cb && cb({ success: false, error: 'Room not found' });
    const isMidGame = room.state !== 'lobby' && room.state !== 'finished';
    if (room.state === 'finished') return cb && cb({ success: false, error: 'Game has ended' });
    if (isMidGame && !isAudience) {
      return cb && cb({ success: false, error: 'Game already started — join as audience instead' });
    }
    const active = activePlayers(room);
    const forced = isAudience || isMidGame || active.length >= 8;
    const tok = token();
    const p = {
      id: 'pl_' + uid(),
      socketId: socket.id,
      token: tok,
      name: (playerName || 'Anonymous').slice(0, 20),
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      isHost: false,
      isAudience: forced,
      score: 0,
      disconnected: false,
      joinedAt: Date.now(),
    };
    room.players.push(p);
    joinChannel(room.code);
    cb && cb({
      success: true,
      sessionToken: tok,
      player: { id: p.id, name: p.name, emoji: p.emoji, isAudience: p.isAudience },
      room: { code: room.code, emojis: room.emojis, hostName: room.hostName, ageRange: room.ageRange, theme: room.theme, state: room.state },
    });
    broadcast(room.code);
  }

  socket.on('join_room', ({ roomCode, emojiCode, playerName, isAudience }, cb) => {
    let room = null;
    if (roomCode) room = rooms[String(roomCode).toUpperCase()];
    else if (emojiCode) room = findRoomByEmojis(emojiCode);
    tryJoin(room, playerName, !!isAudience, cb);
  });

  socket.on('resume_session', ({ roomCode, sessionToken, hostToken }, cb) => {
    const room = rooms[String(roomCode || '').toUpperCase()];
    if (!room) return cb && cb({ success: false, error: 'Room is gone' });
    if (hostToken && room.hostToken === hostToken) {
      room.hostSocketId = socket.id;
      joinChannel(room.code);
      cb && cb({
        success: true,
        role: 'host',
        room: { code: room.code, emojis: room.emojis, hostName: room.hostName, ageRange: room.ageRange, theme: room.theme, state: room.state },
      });
      broadcast(room.code);
      return;
    }
    if (sessionToken) {
      const p = playerByToken(room, sessionToken);
      if (!p || p.removed) return cb && cb({ success: false, error: 'Player not found' });
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
      p.socketId = socket.id;
      p.disconnected = false;
      joinChannel(room.code);
      const cbData = {
        success: true,
        role: p.isAudience ? 'audience' : 'player',
        sessionToken: p.token,
        player: { id: p.id, name: p.name, emoji: p.emoji, isAudience: p.isAudience },
        room: { code: room.code, emojis: room.emojis, hostName: room.hostName, ageRange: room.ageRange, theme: room.theme, state: room.state },
      };
      if (room.state === 'answering') Object.assign(cbData, { yourPrompts: snapshotForPlayer(room, p).prompts });
      cb && cb(cbData);
      broadcast(room.code);
      return;
    }
    cb && cb({ success: false, error: 'No token provided' });
  });

  socket.on('start_game', async (cb) => {
    const room = rooms[currentRoom];
    if (!room || !isHostSocket(room, socket.id)) return cb && cb({ success: false, error: 'Only host' });
    const active = activePlayers(room);
    if (active.length < 3) return cb && cb({ success: false, error: 'Need 3+ players to start' });
    room.currentRound = 1;
    try {
      await startRound(room);
      cb && cb({ success: true });
    } catch (e) {
      cb && cb({ success: false, error: e.message });
    }
  });

  socket.on('fetch_my_prompts', (cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb && cb({ success: false, error: 'No room' });
    const player = playerBySocket(room, socket.id);
    if (!player) return cb && cb({ success: false, error: 'Not a player' });
    const mine = room.prompts.filter(p => p.playerId === player.id).map(p => ({ id: p.id, text: p.text, answer: p.answer }));
    cb && cb({ success: true, prompts: mine });
  });

  socket.on('submit_answer', ({ promptId, answer }, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb && cb({ success: false, error: 'No room' });
    if (room.state !== 'answering') return cb && cb({ success: false, error: 'Not answering' });
    const player = playerBySocket(room, socket.id);
    if (!player) return cb && cb({ success: false, error: 'Not a player' });
    const p = room.prompts.find(x => x.id === promptId);
    if (!p) return cb && cb({ success: false, error: 'Prompt not found' });
    if (p.playerId !== player.id) return cb && cb({ success: false, error: 'Not your prompt' });
    if (p.answer) return cb && cb({ success: false, error: 'Already answered' });
    p.answer = (answer || '').toString().slice(0, 200);
    if (room.prompts.every(x => x.answer !== null)) {
      room.state = 'voting';
      setPhaseTimer(room, VOTE_MS, () => endVotingPhase(room));
    }
    broadcast(room.code);
    cb && cb({ success: true });
  });

  socket.on('submit_vote', ({ promptId }, cb) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'voting') return cb && cb({ success: false, error: 'Not voting' });
    const player = playerBySocket(room, socket.id);
    if (!player) return cb && cb({ success: false, error: 'Not a player' });
    const p = room.prompts.find(x => x.id === promptId);
    if (!p) return cb && cb({ success: false, error: 'Not found' });
    if (p.playerId === player.id) return cb && cb({ success: false, error: 'Cannot vote own' });
    if (!room.votes[player.id]) room.votes[player.id] = [];
    const own = room.prompts.filter(x => x.playerId === player.id).length;
    const eligible = room.prompts.filter(x => x.answer).length - own;
    const voteCap = room.isLastLash ? Math.min(2, eligible) : Math.floor(eligible / 2);
    if (room.votes[player.id].length >= voteCap) return cb && cb({ success: false, error: 'Vote limit reached' });
    if (room.votes[player.id].includes(promptId)) return cb && cb({ success: false, error: 'Already voted' });
    room.votes[player.id].push(promptId);
    if (votingComplete(room)) {
      tally(room);
      room.state = 'results';
      clearPhaseTimer(room);
    }
    broadcast(room.code);
    cb && cb({ success: true });
  });

  socket.on('force_results', (cb) => {
    const room = rooms[currentRoom];
    if (!room || !isHostSocket(room, socket.id)) return cb && cb({ success: false, error: 'Only host' });
    if (room.state !== 'voting') return cb && cb({ success: false, error: 'Not voting' });
    tally(room);
    room.state = 'results';
    clearPhaseTimer(room);
    broadcast(room.code);
    cb && cb({ success: true });
  });

  socket.on('force_advance', (cb) => {
    // Host can force-end the answering phase early (auto-fills missing answers)
    const room = rooms[currentRoom];
    if (!room || !isHostSocket(room, socket.id)) return cb && cb({ success: false, error: 'Only host' });
    if (room.state !== 'answering') return cb && cb({ success: false, error: 'Not answering' });
    endAnsweringPhase(room);
    cb && cb({ success: true });
  });

  socket.on('kick_player', ({ playerId }, cb) => {
    const room = rooms[currentRoom];
    if (!room || !isHostSocket(room, socket.id)) return cb && cb({ success: false, error: 'Only host' });
    const p = room.players.find(x => x.id === playerId);
    if (!p) return cb && cb({ success: false, error: 'Player not found' });
    p.removed = true;
    p.disconnected = true;
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.emit('kicked'); s.disconnect(true); }
    }
    // If we were waiting on this player, re-check phase completion
    if (room.state === 'voting' && votingComplete(room)) {
      tally(room);
      room.state = 'results';
      clearPhaseTimer(room);
    }
    broadcast(room.code);
    cb && cb({ success: true });
  });

  socket.on('next_round', async (cb) => {
    const room = rooms[currentRoom];
    if (!room || !isHostSocket(room, socket.id)) return cb && cb({ success: false, error: 'Only host' });
    if (room.currentRound >= room.maxRounds) {
      room.state = 'finished';
      clearPhaseTimer(room);
      broadcast(room.code);
      return cb && cb({ success: true });
    }
    room.currentRound++;
    try {
      await startRound(room);
      cb && cb({ success: true });
    } catch (e) {
      cb && cb({ success: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (isHostSocket(room, socket.id)) {
      room.hostSocketId = null;
      // Don't tear down the room — host might reload/refresh
      return;
    }
    const p = playerBySocket(room, socket.id);
    if (!p) return;
    p.disconnected = true;
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    p.disconnectTimer = setTimeout(() => {
      if (!rooms[room.code]) return;
      const cur = playerByToken(room, p.token);
      if (!cur || !cur.disconnected) return;
      cur.removed = true;
      // Re-check completion if applicable
      if (room.state === 'voting' && votingComplete(room)) {
        tally(room);
        room.state = 'results';
        clearPhaseTimer(room);
      }
      const stillThere = visiblePlayers(room).length > 0 || room.hostSocketId;
      if (!stillThere) { clearPhaseTimer(room); delete rooms[room.code]; return; }
      broadcast(room.code);
    }, RECONNECT_GRACE_MS);
    broadcast(room.code);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Digual Games running on http://${HOST}:${PORT} (AI=${HAS_AI ? 'on' : 'fallback'}) ANSWER=${ANSWER_MS}ms VOTE=${VOTE_MS}ms`);
});

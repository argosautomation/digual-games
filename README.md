# Digual Games — Quiplash Clone 🎤

A real-time multiplayer party game where players write funny answers to AI-generated prompts and vote for the best ones. Think Jackbox's Quiplash, self-hosted.

## Features

- **AI-Powered Prompts** — Generated on-the-fly via Deepseek API across 5 themes (Mixed, Sports, Entertainment, Pirates, Food)
- **Age-Appropriate Content** — Choose Kids (G-rated), Teens (PG-13), or Adults (edgy) — prompts adapt automatically
- **QR Code or Emoji Joining** — Scan the QR on the TV, or open `digual.com/games` and tap the 4 emojis shown on the TV (no QR needed)
- **3-8 Active Players + Audience** — Minimum 3 players required to start; first 8 join as players, everyone after as audience (can still vote)
- **Head-to-head Voting** — Each round you compare two answers from the same author and pick the funnier one
- **Can't Vote Yourself** — Players see all answers except their own
- **Emoji Identities** — Anonymous player badges with random emoji avatars
- **3 Rounds** — Each round gives 2 prompts per player, then votes are tallied; final round ("Last Lash") is a shared prompt with 2× scoring
- **No Repeat Prompts** — Used prompts are tracked per-room so you never see the same question twice in a single game
- **Real-Time** — Powered by Socket.IO, all state syncs instantly
- **Roku TV Native Client** — Roku app (`digual-tv-roku`) acts as the host TV via REST polling, no socket needed

## How It Works

1. **Host** opens `digual.com/games` on a TV/projector, sets age & theme, creates a room. The host's TV is a display only — the host does not play or vote from the TV.
2. **Players** either scan the QR code with their phone camera, OR open `digual.com/games` on their phone, tap "Join an existing game", and either type the room code or tap the 4 emojis displayed on the TV.
3. **Enter nickname** → tap Join → waiting for game to start
4. **Host starts** the game → each player gets 2 prompts on their phone
5. **Players type** funny answers → submitted for all to see
6. **Everyone votes** on the funniest answers (except their own)
7. **Scores are tallied** → next round or final winner revealed

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS (responsive, TV + mobile layouts)
- **AI:** Deepseek API (with fallback prompt pool)
- **QR:** qrcode library
- **Auth:** None required — anonymous room-based gameplay
- **Deployment:** PM2 + nginx reverse proxy

## Setup

```bash
git clone https://github.com/argosautomation/digual-games
cd digual-games
npm install
cp .env.example .env  # Add DEEPSEEK_API_KEY
node server.js
```

Then open `http://localhost:3201` — the TV interface is responsive and detects mobile vs desktop automatically.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPSEEK_API_KEY` | No | Deepseek API key for AI prompt generation. If unset, server falls back to a built-in pool. |
| `PORT` | No | Listen port (default `3201`) |
| `HOST` | No | Listen host (default `127.0.0.1`) |
| `PUBLIC_URL` | No | Public URL embedded in QR codes (default `https://digual.com/games`) |
| `ALLOWED_ORIGINS` | No | Comma-separated origins for Socket.IO CORS. Empty = `*` (dev only). Example: `https://digual.com` |
| `ANSWER_MS` | No | Answering phase length in ms (default `75000`) |
| `VOTE_MS` | No | Voting phase length in ms (default `30000`) |

## Roku REST API

The Roku TV client doesn't use Socket.IO — it polls REST endpoints over HTTPS. Three endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/roku/create-room` | Create a new room. Body: `{ hostName, ageRange, theme }`. Returns `{ success, roomCode, emojis, hostToken }`. |
| `GET`  | `/api/roku/state/:roomCode` | Returns the current room state (same payload Socket.IO broadcasts). |
| `POST` | `/api/roku/action/:roomCode` | Trigger a host action. Body: `{ token, action }` where `action` is `start_game` \| `next_round` \| `force_advance` \| `force_results`. Requires the `hostToken` returned from create-room. |

Inputs are validated server-side: `ageRange` must be one of `kids`/`teens`/`adults`, `theme` must be one of the registered themes (default `derby`), `hostName` is sanitized to printable chars and trimmed to 20 characters. Roku polls `/api/roku/state/...` every 1.5s while a game is active.

## Deployment

The game server runs on port 3201 behind nginx which handles SSL and WebSocket proxying. A PM2 process keeps it alive.

### Nginx with Socket.IO

The socket.io path is `/socket.io` with nginx prefix stripping. The frontend loads the client at `/games/socket.io/socket.io.js`. Example location block:

```nginx
location /games/ {
    proxy_pass http://127.0.0.1:3201/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
    proxy_connect_timeout 10s;
}
```

## License

MIT

# Digual Games — Quiplash Clone 🎤

A real-time multiplayer party game where players write funny answers to AI-generated prompts and vote for the best ones. Think Jackbox's Quiplash, self-hosted.

## Features

- **AI-Powered Prompts** — Generated on-the-fly via Deepseek API across 5 themes (Mixed, Sports, Entertainment, Pirates, Food)
- **Age-Appropriate Content** — Choose Kids (G-rated), Teens (PG-13), or Adults (edgy) — prompts adapt automatically
- **QR Code Joining** — Scan the QR on the TV screen with your phone to join — no app or URL typing needed
- **8 Active Players + Audience** — First 8 join as players, everyone after as audience (can still vote)
- **Can't Vote Yourself** — Players see all answers except their own
- **Emoji Identities** — Anonymous player badges with random emoji avatars
- **3 Rounds** — Each round gives 2 prompts per player, then votes are tallied
- **Real-Time** — Powered by Socket.IO, all state syncs instantly

## How It Works

1. **Host** opens `digual.com/games` on a TV/projector, sets age & theme, creates a room
2. **Players** scan the QR code with their phone camera → opens the join screen
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
| `DEEPSEEK_API_KEY` | Yes | Deepseek API key for AI prompt generation |

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

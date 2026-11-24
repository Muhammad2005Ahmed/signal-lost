# SIGNAL LOST: Interactive 3D Portfolio

An interactive, gamified 3D portfolio by **Muhammad Ahmed** (CS&IT, NED University).
You are a Recovery Engineer restoring power to an abandoned space station. The station AI,
**A.R.I.A**, is a RAG chatbot that answers questions about the portfolio owner.

## Two ways to explore

On the first screen the visitor chooses:

- **Play the mission**: the full game (rooms, mini-games, A.R.I.A). Link straight to it with `/#play`.
- **Quick portfolio**: a normal scrolling page over a Three.js scene, no game. Link straight to it with `/#quick`.

The quick portfolio lives in `client/src/portfolio/` and reads `data/profile.json`, `data/resume.json` and `data/projects.json`.
The CV PDF is `client/public/cv/Muhammad_Ahmed_Resume.pdf` (see `contact.cv` in `data/profile.json`).

## Tech stack

- Client: Vite, vanilla JavaScript (ES modules), Three.js, GSAP
- Server: Node.js, Express, helmet, cors, express-rate-limit, nodemailer
- A.R.I.A: Retrieval-Augmented Generation with Google Gemini (`@google/generative-ai`)

## Prerequisites

- Node.js 20.19 or newer (Vite requirement). Check with `node -v`
- npm
- Gemini API key (https://aistudio.google.com/app/apikey)
- SMTP credentials for the contact form (Gmail App Password works)

## Local setup

```bash
# 1. From the signal-lost/ folder, install everything
npm run setup

# 2. Create your env file
cp server/.env.example server/.env      # Windows: copy server\.env.example server\.env
# then open server/.env and fill in GEMINI_API_KEY and EMAIL_USER / EMAIL_PASS / EMAIL_TO

# 3. Run client + server together
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:5000 (health check at http://localhost:5173/api/health)

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Installs root, client and server dependencies |
| `npm run dev` | Runs client and server together |
| `npm run client` | Client only |
| `npm run server` | Server only |
| `npm run build` | Production build of the client |
| `npm start` | Starts the server (set `NODE_ENV=production` to serve `client/dist`) |

## Project structure

```
signal-lost/
  client/
    index.html, vite.config.js
    public/ (models, video, audio)
    src/
      core/    main.js, events.js, state.js (+ scene, loader, input, audio later)
      rooms/   hub, about, projects, skills, education, beacon
      games/   wires, oxygen, asteroids, codebreaker
      ui/      hud, chat, modal, contactForm, achievements, mobileNav
      avatar/  avatar.js
      styles/  main.css
  server/
    index.js, routes/ (chat, contact), rag/ (ingest, retrieve, store.json)
  data/        profile.json, about.json, education.json, projects.json, skills.json, achievements.json, knowledge/*.md
```

## Controls

| Input | Action |
| --- | --- |
| Mouse move | Camera parallax in the hub |
| Click a door | 1.2s fly-through into that room |
| Tab / Shift+Tab, Enter | Keyboard navigation of doors, core, avatar |
| Esc or BACK TO HUB | Return to the hub from any room |
| D | Print game state to the browser console (debug) |
| (HUD speaker icon) | Mute / unmute audio. Sound always starts ON; mute is not remembered |
| C, HUD A.R.I.A button, hub terminal, astronaut click | Open the A.R.I.A terminal (chat). Esc closes it |

## A.R.I.A terminal (chat)

`client/src/ui/chat.js` + `client/src/styles/chat.css`, used by both the game and the Quick Portfolio. It needs the server (`npm run ingest` once, then `npm run dev`). Answers show a confidence bar (from the retrieval score; tune `CONF_LOW` / `CONF_HIGH` in chat.js together with `RAG_MIN_SCORE`) and `DATA LOG: file.md` chips that open the matching project or the source snippet. Voice input and spoken answers use the browser's Web Speech API (Chrome and Edge work best; Urdu depends on the browser's speech engine). The chat counts `questionsAsked` and unlocks `chatterbox` (5 questions) and `linguist` (an Urdu or Roman Urdu question). A.R.I.A answers in English, Urdu (script) or Roman Urdu.

**Gemini model:** the default is `gemini-3.8-flash` (`gemini-2.5-flash` is closed to new API users). If `GEMINI_MODEL` in `server/.env` is retired (404), the server automatically tries `gemini-3.8-flash`, `3.6-flash`, `3.5-flash-lite`. Set `GEMINI_MODEL=gemini-3.8-flash` in `server/.env` and restart `npm run dev`.

## Contact form (Comms Tower / Beacon)

Frontend: `client/src/ui/contactForm.js` (used by the Comms Tower room and the Quick Portfolio) and `client/src/rooms/beacon.js`.
Backend: `server/routes/contact.js` -> `POST /api/contact`. Protection: CORS limited to `CLIENT_URL`, 3 sends per 10 minutes per IP, hidden honeypot field `website`, minimum 3 seconds on the form (`X-Form-Opened` header), validation + escaping, escaped HTML and plain-text email, reply-to set to the visitor.

### Gmail App Password (EMAIL_PASS)

1. Open your Google Account: https://myaccount.google.com and go to **Security**.
2. Turn on **2-Step Verification** (App Passwords only exist when it is on).
3. Open https://myaccount.google.com/apppasswords (or search "App passwords" in the account search bar).
4. Type an app name, for example `SIGNAL LOST`, and click **Create**.
5. Google shows a 16-character password (like `abcd efgh ijkl mnop`). Copy it now; it is shown only once.
6. In `server/.env` set `EMAIL_USER=yourname@gmail.com`, `EMAIL_PASS=abcdefghijklmnop` (spaces are optional) and `EMAIL_TO=` the inbox that should receive messages.
7. Restart the server (`Ctrl+C`, then `npm run dev`).

Not available? App Passwords are hidden for school/work accounts, accounts with Advanced Protection, and 2-Step Verification that uses only security keys. Use a normal personal Gmail account. Never put your real Gmail password in `.env`, and never commit `.env`.

### Test it

```bash
npm run test:contact        # sends 1 real email + a honeypot + 2 invalid attempts
```

curl (Mac/Linux/Git Bash):

```bash
curl -i -X POST http://localhost:5000/api/contact \
  -H "Content-Type: application/json" \
  -H "X-Form-Opened: $(( $(date +%s) * 1000 - 5000 ))" \
  -d '{"name":"Test User","email":"test@example.com","subject":"Curl test","message":"Hello from the terminal, this is a test message.","website":""}'
```

Windows PowerShell:

```powershell
$t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 5000
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/contact -ContentType 'application/json' -Headers @{ 'X-Form-Opened' = "$t" } -Body '{"name":"Test User","email":"test@example.com","subject":"Curl test","message":"Hello from the terminal, this is a test message.","website":""}'
```

Success is `{"ok":true}` and a new email in the `EMAIL_TO` inbox.

## Core engine files

- `src/core/scene.js`: renderer, camera, UnrealBloomPass post-processing, resize, loop, adaptive quality
- `src/core/loader.js`: LoadingManager, GLTFLoader + DRACOLoader, textures clamped to 1024px
- `src/core/input.js`: raycasting, hover state, click events, hidden keyboard proxies and focus ring
- `src/core/audio.js`: procedural Web Audio (no audio files needed)
- `src/rooms/hub.js`: the hub room (all procedural geometry)
- `src/rooms/projects.js`, `src/games/wires.js`, `src/ui/modal.js`: Engineering Bay, wires mini-game, modal
- `src/rooms/skills.js`, `src/games/oxygen.js`: Reactor Core (skills radar) and the stabilizer mini-game
- `src/rooms/education.js`, `src/games/asteroids.js`: Archive (timeline from `data/education.json`) and the asteroid dodge game
- `src/rooms/about.js`, `src/games/codebreaker.js`: Crew Quarters (profile from `data/about.json`) and the Wordle-style game
- `src/ui/hud.js`, `src/ui/achievements.js`: top bar, rank-up banner, oxygen + cells, XP-depleted game over, rogue-signal mission (one A.R.I.A question), achievement toasts
- `src/core/progress.js`: turns game events into saved XP, power, achievements

The Draco decoder is copied to `client/public/draco` automatically by `npm install` / `npm run dev`.

## Shared contracts

- **Event bus** (`src/core/events.js`): `emit`, `on`, `off`. Events: `room:enter`, `room:power`,
  `xp:add`, `achievement:unlock`, `game:win`, `game:lose`, `chat:answer`, `avatar:talk`.
- **Game state** (`src/core/state.js`): `getState()`, `update(partial)`, `reset()`, saved in
  localStorage key `signal-lost-save`. Power % = powered rooms / 4 * 100.
- **Ranks**: Cadet 0, Technician 100, Engineer 250, Commander 450, Station Legend 700 XP.
- **Rooms**: hub, about (Crew Quarters), projects (Engineering Bay), skills (Reactor Core),
  education (Archive), beacon (Comms Tower). Each exports `{ init(scene, ctx), enter(), exit(), update(dt) }`.
- **Avatar**: `client/public/models/astronaut.glb`, height 1.8 units, origin at feet, facing +Z,
  clips `Idle`, `Wave`, `Talk`, `Shrug`, morph targets `mouthOpen`, `smile`, `blink`. Keep GLB under 5 MB.

## API

- `POST /api/chat` body `{ message, lang: 'en' | 'ur' }` returns `{ answer, found, sources: [{ id, title, snippet, score }] }`
- `POST /api/contact` body `{ name, email, subject, message, website }` returns `{ ok, error? }`.
  `website` is a honeypot and must stay empty.
- `GET /api/health` returns `{ ok: true }`
- `GET /api/leaderboard` returns `{ ok, entries }`; `POST /api/leaderboard` body `{ name, xp, achievements? }` returns `{ ok, entries, placed }`.
  Top 10 are stored in `server/data/leaderboard.json`. Scores come from the browser, so they can be faked.

Until `routes/chat.js` and `routes/contact.js` exist, those endpoints return a 501 stub.

## Style

Dark sci-fi. Accent cyan `#00E5FF`, warning orange `#FF6B2C`, background `#05070D`.
Fonts: Orbitron (headings), Share Tech Mono (body).

## Performance, mobile and accessibility

- Pixel ratio capped at 2, textures max 1024, dispose geometries and materials on room exit
- Under 768px width a simplified tap UI (`mobileNav.js`) uses the same content and game state
- `prefers-reduced-motion` is respected

## Deployment

1. `npm run build`
2. Set `NODE_ENV=production` and the env vars from `.env.example` on your host
3. `npm start` serves the API and the built client from one origin

## Troubleshooting

- **Uplink offline in the loader:** the server is not running or not on port 5000
- **Blank screen / WebGL error:** enable hardware acceleration or try another browser
- **Contact form fails:** use a Gmail App Password, not your normal password
- **Port already in use:** change `PORT` in `server/.env` and the proxy target in `client/vite.config.js`

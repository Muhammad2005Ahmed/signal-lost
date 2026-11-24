// SIGNAL LOST API: Express + helmet + cors + 10kb JSON limit.
// Routes in ./routes are mounted if present (each must `export default` an express.Router
// that handles POST '/'); otherwise a 501 stub is mounted so the server always boots.

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import contactRouter from './routes/contact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5000;
const isProd = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1); // correct client IPs behind a host proxy

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
  })
);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      const err = new Error('Origin not allowed');
      err.status = 403;
      cb(err);
    },
    methods: ['GET', 'POST'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '10kb' }));

app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.RATE_LIMIT_PER_MIN) || 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests, slow down.' },
  })
);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'signal-lost', time: new Date().toISOString() });
});

async function mountOptional(mountPath, file, fallbackBody) {
  const full = path.join(__dirname, file);
  if (fs.existsSync(full)) {
    const mod = await import(pathToFileURL(full).href);
    app.use(mountPath, mod.default);
    console.log(`[server] mounted ${mountPath} <- ${file}`);
  } else {
    app.use(mountPath, (req, res) => res.status(501).json(fallbackBody));
    console.warn(`[server] ${file} not found, ${mountPath} returns 501 until it is created`);
  }
}

await mountOptional('/api/chat', 'routes/chat.js', { answer: 'A.R.I.A is offline.', found: false, sources: [] });
await mountOptional('/api/tts', 'routes/tts.js', { ok: false, error: 'TTS route not installed yet.' });
await mountOptional('/api/leaderboard', 'routes/leaderboard.js', { ok: false, entries: [], error: 'Leaderboard route not installed yet.' });
app.use('/api/contact', contactRouter);
console.log('[server] mounted /api/contact <- routes/contact.js');

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Production: serve the built client from the same origin.
if (isProd) {
  const dist = path.join(__dirname, '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method === 'GET') return res.sendFile(path.join(dist, 'index.html'));
      next();
    });
  }
}

// Central error handler: never leak internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[server] error:', err);
  const error =
    status === 413 ? 'Payload too large'
    : status === 403 ? err.message
    : status === 400 ? 'Bad request'
    : 'Server error';
  res.status(status).json({ ok: false, error });
});

// On Vercel the app runs as a serverless function (see api/index.js): it must not listen on a port.
export default app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, async () => {
    console.log(`[server] SIGNAL LOST API listening on http://localhost:${PORT}`);
    // A.R.I.A status: tells the owner at a glance whether chat will work
    try {
      const { storeInfo } = await import('./rag/retrieve.js');
      const info = await storeInfo();
      if (!info.chunks) console.warn('[rag] no index yet: run "npm run ingest" to build rag/store.json');
      else console.log(`[rag] index ready: ${info.chunks} chunks, ${info.dims} dims`);
      if (!process.env.GEMINI_API_KEY) console.warn('[rag] GEMINI_API_KEY is not set: /api/chat will answer 503');
    } catch (err) {
      console.warn('[rag] could not read the index:', err.message);
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

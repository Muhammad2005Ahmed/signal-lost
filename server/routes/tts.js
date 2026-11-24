// POST /api/tts  body { text }  ->  audio/wav. Reads Urdu / Roman Urdu answers aloud (Gemini speech).
// Rate limited; the text is capped. The client falls back to the browser voice if this fails.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { synthesize, hasKey, GeminiError } from '../rag/gemini.js';

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.TTS_RATE_PER_MIN) || 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { ok: false, error: 'rate_limited' } }));

router.post('/', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
  if (text.length < 2 || text.length > 600) return res.status(400).json({ ok: false, error: 'invalid_text' });
  if (!hasKey()) return res.status(503).json({ ok: false, error: 'no_key' });
  try {
    const wav = await synthesize(text);
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(wav);
  } catch (err) {
    console.error('[tts]', err instanceof GeminiError ? err.message : err);
    res.status(502).json({ ok: false, error: 'upstream' });
  }
});

export default router;

// Thin Gemini REST client (no SDK): embeddings for the RAG index and text generation for A.R.I.A.
// Reads its settings from the environment on every call, so tests can point it at a mock server.
//   GEMINI_API_KEY       required
//   GEMINI_EMBED_MODEL   default gemini-embedding-001
//   GEMINI_MODEL         default gemini-3.5-flash-lite (fastest). If the model is unavailable (404) the next one in FALLBACKS is tried.
//   EMBED_DIMS           default 768 (vectors are normalised here, so dot product == cosine)
//   GEMINI_TTS_MODEL     default gemini-2.5-flash-preview-tts (text to speech for Urdu / Roman Urdu answers)
//   GEMINI_BASE_URL      default https://generativelanguage.googleapis.com/v1beta

const BASE = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const EMBED_MODEL = () => process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const GEN_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Tried in order when a model answers 404 (retired or not available for this key). The first one that works is remembered.
const FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
let workingModel = '';
const DIMS = () => Number(process.env.EMBED_DIMS) || 768;
const BATCH = 50; // embedContents requests per HTTP call

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export const hasKey = () => Boolean(process.env.GEMINI_API_KEY);

/** POST with retries on 429 / 5xx (exponential backoff). The API key goes in a header, never in logs. */
async function post(path, body, { tries = 4, timeoutMs = 25_000 } = {}) {
  if (!hasKey()) throw new GeminiError('GEMINI_API_KEY is not set', 503);
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(`${BASE()}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      lastErr = new GeminiError(`Gemini ${res.status}: ${detail}`, res.status);
      if (res.status !== 429 && res.status < 500) throw lastErr; // bad request / bad key: do not retry
    } catch (err) {
      if (err instanceof GeminiError && err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err instanceof GeminiError ? err : new GeminiError(`Gemini request failed: ${err.message}`, 502);
    }
    if (attempt < tries - 1) await sleep(700 * 2 ** attempt);
  }
  throw lastErr;
}

function normalise(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Embed many texts. taskType: 'RETRIEVAL_DOCUMENT' for chunks, 'RETRIEVAL_QUERY' for questions. */
export async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const data = await post(`models/${EMBED_MODEL()}:batchEmbedContents`, {
      requests: slice.map((text) => ({
        model: `models/${EMBED_MODEL()}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: DIMS(),
      })),
    });
    const vectors = data.embeddings || [];
    if (vectors.length !== slice.length) throw new GeminiError('Embedding response had the wrong size', 502);
    for (const e of vectors) out.push(normalise(e.values));
  }
  return out;
}

export async function embedQuery(text) {
  const [v] = await embedTexts([text], 'RETRIEVAL_QUERY');
  return v;
}

// 404 = model retired; 502 = timeout; 503 = model overloaded (Google's "high demand"): in both cases another model may work
const isGone = (err) => err instanceof GeminiError && (err.status === 404 || err.status === 502 || err.status === 503 || /no longer available|not found/i.test(err.message));

async function generateWith(model, { system, prompt }) {
  const base = { temperature: 0.2, maxOutputTokens: 400 };
  const call = (generationConfig) => post(`models/${model}:generateContent`, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  }, { tries: 2, timeoutMs: 20_000 });
  // "Thinking" makes answers slow. A short grounded answer does not need it: switch it off / to minimum.
  let data;
  if (/gemini-2\.5/.test(model)) data = await call({ ...base, thinkingConfig: { thinkingBudget: 0 } });
  else {
    try {
      data = await call({ ...base, thinkingConfig: { thinkingLevel: 'minimal' } });
    } catch (err) {
      if (err.status !== 400) throw err; // this model does not accept the setting: ask without it
      data = await call(base);
    }
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new GeminiError(`Gemini returned no text (${data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty'})`, 502);
  return text;
}

/** One grounded answer. Returns the plain text of the first candidate. Falls back to newer/other models on 404. */
export async function generate({ system, prompt }) {
  const chain = [...new Set([workingModel, GEN_MODEL(), ...FALLBACKS].filter(Boolean))];
  let lastErr;
  for (const model of chain) {
    try {
      const text = await generateWith(model, { system, prompt });
      if (workingModel !== model) {
        if (workingModel || model !== GEN_MODEL()) console.warn(`[gemini] using model ${model}. Set GEMINI_MODEL=${model} in server/.env to make it permanent.`);
        workingModel = model;
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (!isGone(err)) throw err; // quota, bad key, 5xx etc.: another model will not help
      console.warn(`[gemini] model ${model} is not available (${err.status}), trying the next one`);
      if (model === workingModel) workingModel = '';
    }
  }
  throw lastErr;
}

// ---------- text to speech (Urdu and Roman Urdu: browsers have no good Urdu voice) ----------
const TTS_MODEL = () => process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

/** 16-bit mono PCM -> WAV file buffer. */
export function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Speak `text` in a natural Urdu voice. Returns a WAV Buffer. */
export async function synthesize(text) {
  const data = await post(`models/${TTS_MODEL()}:generateContent`, {
    contents: [{ parts: [{ text: `Read this aloud clearly in natural Urdu (it may be written in Roman Urdu or English letters): ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  }, { tries: 2, timeoutMs: 25_000 });
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) throw new GeminiError('Gemini returned no audio', 502);
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
  return pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate);
}

// Leaderboard route: GET /api/leaderboard -> { ok, entries }, POST /api/leaderboard -> { ok, entries, placed }.
// Keeps the top 10 scores in server/data/leaderboard.json (created on first write).
// Basic validation only: the score comes from the browser, so it can be faked. It is a fun board, not a secure one.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LEADERBOARD_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'leaderboard.json');
const MAX_ENTRIES = 10;
const MAX_XP = 2000; // far above anything reachable in the game
const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;
const RANKS = [
  ['Cadet', 0],
  ['Technician', 100],
  ['Engineer', 250],
  ['Commander', 450],
  ['Station Legend', 700],
];

/** The rank is always derived on the server; the client's own rank claim is ignored. */
export function rankFor(xp) {
  let name = RANKS[0][0];
  for (const [n, min] of RANKS) if (xp >= min) name = n;
  return name;
}

/** Validate a POST body. Returns { entry } or { error }. */
export function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid request body.' };
  if (typeof body.name !== 'string') return { error: 'Name is required.' };
  const name = body.name.trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) return { error: 'Name must be 2-16 letters, digits, spaces, _ or -.' };
  if (!Number.isInteger(body.xp) || body.xp < 0 || body.xp > MAX_XP) return { error: `XP must be a whole number from 0 to ${MAX_XP}.` };
  let achievements = 0;
  if (body.achievements !== undefined) {
    if (!Number.isInteger(body.achievements) || body.achievements < 0 || body.achievements > 50) return { error: 'Invalid achievements count.' };
    achievements = body.achievements;
  }
  return { entry: { name, xp: body.xp, rank: rankFor(body.xp), achievements, date: new Date().toISOString() } };
}

/** Add a score. One row per name (case-insensitive): a name keeps its best score. Returns { entries, placed }. */
export function insertEntry(entries, entry) {
  const key = entry.name.toLowerCase();
  const list = entries.filter((e) => e.name.toLowerCase() !== key);
  const old = entries.find((e) => e.name.toLowerCase() === key);
  list.push(old && old.xp >= entry.xp ? old : entry);
  list.sort((a, b) => b.xp - a.xp || a.date.localeCompare(b.date));
  const top = list.slice(0, MAX_ENTRIES);
  return { entries: top, placed: top.some((e) => e.name.toLowerCase() === key && e.xp === entry.xp) };
}

/** Keep only well-formed rows, so a hand-edited file cannot break the API. */
function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && NAME_RE.test(r.name) && Number.isInteger(r.xp) && r.xp >= 0 && typeof r.date === 'string')
    .map((r) => ({ name: r.name, xp: r.xp, rank: rankFor(r.xp), achievements: Number.isInteger(r.achievements) ? r.achievements : 0, date: r.date }))
    .sort((a, b) => b.xp - a.xp || a.date.localeCompare(b.date))
    .slice(0, MAX_ENTRIES);
}

async function readEntries() {
  try {
    return cleanRows(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch {
    return []; // no file yet, or unreadable: start fresh
  }
}

async function writeEntries(entries) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fs.rename(tmp, FILE); // atomic replace
}

// Serialize read-modify-write so two simultaneous submissions cannot overwrite each other
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

const router = Router();
const postLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions, try again in a minute.' },
});

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, entries: await readEntries() });
  } catch {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/', postLimit, async (req, res) => {
  const { entry, error } = validateSubmission(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  try {
    const result = await locked(async () => {
      const out = insertEntry(await readEntries(), entry);
      await writeEntries(out.entries);
      return out;
    });
    res.json({ ok: true, entries: result.entries, placed: result.placed });
  } catch {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

export default router;

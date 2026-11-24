// Build the vector index. Run: npm run ingest   (from the server folder, or `npm run ingest` at the project root)
// data/knowledge/*.md -> chunks of ~450 characters (80 overlap) -> Gemini embeddings -> server/rag/store.json
// Each store entry: { id, text, source, title, embedding }.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embedTexts, hasKey } from './gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_DIR = path.join(__dirname, '../../data/knowledge');
export const STORE_FILE = path.join(__dirname, 'store.json');

const CHUNK = 450; // target characters per chunk
const OVERLAP = 80;
const MIN_LEN = 25; // skip fragments that are too short to mean anything

/** Cut `text` into windows of ~size characters, preferring sentence/space boundaries, with overlap. */
export function windowText(text, size = CHUNK, overlap = OVERLAP) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= size + 50) return t ? [t] : []; // small enough: keep whole
  const parts = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + size, t.length);
    if (end < t.length) {
      const window = t.slice(start, end);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      if (cut > size * 0.5) end = start + cut + 1;
      else {
        const sp = window.lastIndexOf(' ');
        if (sp > size * 0.5) end = start + sp;
      }
    }
    parts.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = Math.max(end - overlap, start + 1);
    const nextSpace = t.indexOf(' ', start); // begin the next window on a word boundary
    if (nextSpace !== -1 && nextSpace - start < 25) start = nextSpace + 1;
  }
  return parts.filter(Boolean);
}

/** Split one markdown file by headings, then chunk each section. Keeps the heading as the title. */
export function chunkMarkdown(md, source) {
  const lines = md.split(/\r?\n/);
  let h1 = '';
  let heading = '';
  let buf = [];
  const sections = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ title: [h1, heading].filter(Boolean).join(' > ') || source, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      if (m[1].length === 1) { h1 = m[2].trim(); heading = ''; } else heading = m[2].trim();
    } else if (!line.includes('[MISSING')) buf.push(line); // never index unfinished placeholders
  }
  flush();

  const chunks = [];
  for (const sec of sections) {
    // join paragraphs so short consecutive facts share a chunk instead of becoming tiny fragments
    for (const piece of windowText(sec.body.replace(/\n{2,}/g, ' ').replace(/\n/g, ' '))) {
      if (piece.length >= MIN_LEN) chunks.push({ text: piece, source, title: sec.title });
    }
  }
  return chunks;
}

async function main() {
  if (!hasKey()) {
    console.error('GEMINI_API_KEY is missing. Copy server/.env.example to server/.env and fill it in.');
    process.exit(1);
  }
  const files = (await fs.readdir(KNOWLEDGE_DIR)).filter((f) => f.endsWith('.md')).sort();
  if (!files.length) throw new Error(`No .md files in ${KNOWLEDGE_DIR}`);

  const chunks = [];
  for (const f of files) {
    const md = await fs.readFile(path.join(KNOWLEDGE_DIR, f), 'utf8');
    const list = chunkMarkdown(md, f);
    list.forEach((c, i) => chunks.push({ id: `${f.replace(/\.md$/, '')}-${i + 1}`, ...c }));
    console.log(`  ${f}: ${list.length} chunks`);
  }
  console.log(`Embedding ${chunks.length} chunks...`);

  // The heading is embedded with the text so "Karachi Digital Twin" questions match its sub-sections
  const vectors = await embedTexts(chunks.map((c) => `${c.title}\n${c.text}`), 'RETRIEVAL_DOCUMENT');
  const store = chunks.map((c, i) => ({
    id: c.id,
    text: c.text,
    source: c.source,
    title: c.title,
    embedding: vectors[i].map((x) => Math.round(x * 1e5) / 1e5), // 5 decimals keeps store.json small
  }));
  await fs.writeFile(STORE_FILE, JSON.stringify(store));
  console.log(`Saved ${store.length} chunks (${store[0].embedding.length} dims) to ${path.relative(process.cwd(), STORE_FILE)}`);
}

// Run only when executed directly (`node rag/ingest.js`), not when imported by tests
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('Ingest failed:', err.message);
    process.exit(1);
  });
}

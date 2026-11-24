// Cosine-similarity search over server/rag/store.json. Vectors are normalised at ingest time,
// so cosine similarity is just the dot product. The store is cached and reloaded if the file changes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = process.env.RAG_STORE_FILE || path.join(__dirname, 'store.json');

let cache = { mtimeMs: 0, chunks: [] };

/** Load (or reload) the index. Returns [] when ingest has not been run yet. */
export async function loadStore() {
  try {
    const st = await fs.stat(STORE_FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const chunks = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
      cache = { mtimeMs: st.mtimeMs, chunks: Array.isArray(chunks) ? chunks : [] };
    }
  } catch {
    cache = { mtimeMs: 0, chunks: [] };
  }
  return cache.chunks;
}

export async function storeInfo() {
  const chunks = await loadStore();
  return { chunks: chunks.length, dims: chunks[0]?.embedding?.length || 0 };
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Top-k chunks for a query embedding, best first: [{ id, text, source, title, score }] */
export async function retrieve(queryEmbedding, k = Number(process.env.RAG_TOP_K) || 4) {
  const chunks = await loadStore();
  return chunks
    .map((c) => ({ id: c.id, text: c.text, source: c.source, title: c.title, score: cosine(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

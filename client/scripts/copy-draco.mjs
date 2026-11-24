// Copies the Draco decoder from three.js into public/draco so GLB decoding is served
// from our own origin (works offline and under the server's Content-Security-Policy).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/three/examples/jsm/libs/draco/gltf');
const dest = resolve(root, 'public/draco');

if (!existsSync(src)) {
  console.warn('[draco] three is not installed yet, skipping decoder copy');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[draco] decoder copied to public/draco');

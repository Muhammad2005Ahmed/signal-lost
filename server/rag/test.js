// A.R.I.A test: sends 10 questions to the running server and checks `found` (and key words in the answer).
// Start the server first (npm run server), then: npm run test:rag
// Optional: API=http://localhost:5000 node rag/test.js
// 3 questions are NOT in the knowledge files, so they must return found:false.

const API = process.env.API || `http://localhost:${process.env.PORT || 5000}`;

const TESTS = [
  { q: 'Which university does Muhammad study at?', found: true, expect: /NED/i },
  { q: 'What is his final year project?', found: true, expect: /Karachi Digital Twin/i },
  { q: 'Which game won GameCon?', found: true, expect: /Two Lights One Escape/i },
  { q: 'What position did Sound Mask get at Global Game Jam?', found: true, expect: /(3rd|third)/i },
  { q: 'Did he do an internship?', found: true, expect: /(KDA|Karachi Development Authority)/i },
  { q: 'What is his CGPA?', found: true, expect: /3\.515/ },
  { q: 'محمد احمد کس یونیورسٹی میں پڑھتا ہے؟', found: true, expect: /NED/i }, // Urdu script question
  { q: 'Muhammad ki education kya hai?', found: true, expect: /NED/i }, // Roman Urdu question
  { q: 'What is his monthly salary?', found: false },
  { q: 'What is his home address?', found: false },
  { q: 'What is his favorite food?', found: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

console.log(`Testing ${API}/api/chat\n`);
for (const [i, t] of TESTS.entries()) {
  let out;
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: t.q, lang: 'en' }),
    });
    out = { status: res.status, ...(await res.json()) };
  } catch (err) {
    console.error(`Cannot reach the server (${err.message}). Is "npm run server" running?`);
    process.exit(1);
  }
  const best = out.sources?.[0]?.score;
  const okFound = out.found === t.found;
  const okText = !t.expect || (typeof out.answer === 'string' && t.expect.test(out.answer));
  const pass = out.status === 200 && okFound && okText;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  #${i + 1} found=${out.found} (want ${t.found})${best ? ` top score ${best}` : ''}`);
  console.log(`      Q: ${t.q}`);
  console.log(`      A: ${String(out.answer).replace(/\s+/g, ' ').slice(0, 200)}${out.error ? `  [${out.error}]` : ''}`);
  await sleep(400); // stay well under the 20 requests/min limit
}

console.log(`\n${TESTS.length - failed}/${TESTS.length} passed`);
process.exit(failed ? 1 : 0);

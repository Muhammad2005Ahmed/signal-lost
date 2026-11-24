// Manual test for POST /api/contact. Run the server first (npm run dev), then: npm run test:contact
// It sends ONE real email to EMAIL_TO, plus a honeypot attempt (no email) and an invalid one (rejected).
// Uses 2 of the 3 sends allowed per 10 minutes by the rate limit.

import 'dotenv/config';

const BASE = process.env.API || `http://localhost:${process.env.PORT || 5000}`;
const opened = () => String(Date.now() - 5000); // pretend the form was open for 5 seconds (minimum is 3)

async function send(label, body, headers = {}) {
  try {
    const res = await fetch(`${BASE}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Form-Opened': opened(), ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`${label.padEnd(34)} -> HTTP ${res.status}  ${JSON.stringify(data)}`);
    return res.status;
  } catch (err) {
    console.log(`${label.padEnd(34)} -> FAILED (${err.message}). Is the server running on ${BASE}?`);
    return 0;
  }
}

const good = {
  name: 'Test Visitor',
  email: 'visitor@example.com',
  subject: 'SIGNAL LOST contact test',
  message: 'Hello Muhammad, this is a test of the Beacon contact form.',
  website: '',
};

console.log(`Testing ${BASE}/api/contact\n`);
const a = await send('1. valid message (sends email)', good);
const b = await send('2. honeypot filled (no email)', { ...good, website: 'http://spam.example' });
const c = await send('3. invalid email (rejected)', { ...good, email: 'not-an-email' });
const d = await send('4. missing X-Form-Opened (rejected)', good, { 'X-Form-Opened': '' });
console.log('\nExpected: 1 = 200 {"ok":true} and an email in your inbox, 2 = 200 {"ok":true} but NO email, 3 = 400, 4 = 400.');
process.exit(a === 200 && b === 200 && c === 400 && d === 400 ? 0 : 1);

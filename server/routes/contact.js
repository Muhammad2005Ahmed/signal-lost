// POST /api/contact  body { name, email, subject, message, website }  ->  { ok, error? }
// "SEND DISTRESS SIGNAL TO EARTH": the Beacon form. Protection layers, in order:
//   1. CORS limited to CLIENT_URL        2. rate limit: 3 sends per 10 minutes per IP
//   3. honeypot field `website`          4. minimum time-to-submit (header X-Form-Opened, set by the form)
//   5. validation + sanitizing (validator)   6. escaped HTML + plain-text email through Gmail SMTP (Nodemailer)
// Env: EMAIL_USER, EMAIL_PASS (Gmail App Password), EMAIL_TO, CLIENT_URL (see server/.env.example).

import { Router } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import validator from 'validator';
import nodemailer from 'nodemailer';

const router = Router();

// ---------- limits ----------
export const LIMITS = {
  name: { min: 2, max: 80 },
  email: { max: 254 },
  subject: { min: 3, max: 120 },
  message: { min: 10, max: 2000 },
};
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000; // a form open for more than a day is stale
const minFormMs = () => {
  const s = Number(process.env.CONTACT_MIN_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 3) * 1000;
};

const fail = (res, status, error, fields) => res.status(status).json({ ok: false, error, ...(fields ? { fields } : {}) });

// ---------- 1. CORS: only the site itself may call this route from a browser ----------
const allowedOrigins = () =>
  (process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

router.use(
  cors({
    origin(origin, cb) {
      // No Origin header = same-origin request or a tool like curl: not a cross-site browser call
      if (!origin || allowedOrigins().includes(origin)) return cb(null, true);
      const err = new Error('Origin not allowed');
      err.status = 403;
      cb(err);
    },
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Form-Opened'],
    maxAge: 600,
  })
);

// ---------- 2. rate limit: 3 per 10 minutes per IP (failed validations do not use up a try) ----------
router.use(
  rateLimit({
    windowMs: 10 * 60_000,
    limit: Number(process.env.CONTACT_RATE_LIMIT) || 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipFailedRequests: true,
    message: { ok: false, error: 'Too many transmissions from this signal. Try again in 10 minutes.' },
  })
);

// ---------- sanitizing and validation ----------
/** Remove control characters, trim; single-line fields also lose line breaks (blocks email header injection). */
export function sanitize(value, { multiline = false } = {}) {
  let s = typeof value === 'string' ? value.normalize('NFC') : '';
  s = validator.stripLow(s, multiline); // keeps \n only when multiline
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Returns { clean } or { errors: { field: message } }. */
export function validateContact(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const clean = {
    name: sanitize(b.name),
    email: sanitize(b.email).toLowerCase(),
    subject: sanitize(b.subject),
    message: sanitize(b.message, { multiline: true }),
  };
  const errors = {};
  const L = LIMITS;
  if (!clean.name) errors.name = 'Name is required.';
  else if (clean.name.length < L.name.min || clean.name.length > L.name.max) errors.name = `Name must be ${L.name.min}-${L.name.max} characters.`;
  if (!clean.email) errors.email = 'Email is required.';
  else if (clean.email.length > L.email.max || !validator.isEmail(clean.email)) errors.email = 'Enter a valid email address.';
  if (!clean.subject) errors.subject = 'Subject is required.';
  else if (clean.subject.length < L.subject.min || clean.subject.length > L.subject.max) errors.subject = `Subject must be ${L.subject.min}-${L.subject.max} characters.`;
  if (!clean.message) errors.message = 'Message is required.';
  else if (clean.message.length < L.message.min || clean.message.length > L.message.max) errors.message = `Message must be ${L.message.min}-${L.message.max} characters.`;
  return Object.keys(errors).length ? { errors } : { clean };
}

/** Minimum time-to-submit. `opened` is the X-Form-Opened header (epoch ms). Returns an error string or ''. */
export function checkTiming(opened, now = Date.now()) {
  const t = Number(opened);
  if (!opened || !Number.isFinite(t) || t <= 0 || t > now + 5000) return 'Form session missing. Reload the page and try again.';
  const age = now - t;
  if (age < minFormMs()) return 'That was too fast. Take a moment, then send again.';
  if (age > MAX_FORM_AGE_MS) return 'This form expired. Reload the page and try again.';
  return '';
}

// ---------- email ----------
// EMAIL_* are the documented names; the older SMTP_USER / SMTP_PASS / CONTACT_TO still work as fallbacks
const mailUser = () => process.env.EMAIL_USER || process.env.SMTP_USER || '';
const mailPass = () => String(process.env.EMAIL_PASS || process.env.SMTP_PASS || '').replace(/\s+/g, '');
const mailTo = () => process.env.EMAIL_TO || process.env.CONTACT_TO || mailUser();
const esc = (s) => validator.escape(s);

/** Build the Nodemailer message. Everything that reaches the HTML is escaped. */
export function buildMail({ name, email, subject, message }, meta = {}) {
  const user = mailUser();
  const to = mailTo();
  const when = new Date().toISOString();
  const text = [
    'NEW DISTRESS SIGNAL FROM THE SIGNAL LOST PORTFOLIO',
    '',
    `From:    ${name} <${email}>`,
    `Subject: ${subject}`,
    `Sent:    ${when}`,
    meta.ip ? `IP:      ${meta.ip}` : '',
    '',
    message,
    '',
    '-- Reply to this email to answer the sender directly.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#05070d;font-family:Consolas,'Courier New',monospace;color:#cfeaf2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;border:1px solid #0b6a78;background:#08101c;">
<tr><td style="padding:16px 20px;border-bottom:1px solid #0b6a78;color:#00e5ff;font-size:15px;letter-spacing:2px;">&#9679; DISTRESS SIGNAL RECEIVED</td></tr>
<tr><td style="padding:20px;font-size:14px;line-height:1.6;">
<p style="margin:0 0 4px;color:#6f8c97;font-size:12px;">FROM</p>
<p style="margin:0 0 14px;color:#ffffff;">${esc(name)} &lt;${esc(email)}&gt;</p>
<p style="margin:0 0 4px;color:#6f8c97;font-size:12px;">SUBJECT</p>
<p style="margin:0 0 14px;color:#ff6b2c;">${esc(subject)}</p>
<p style="margin:0 0 4px;color:#6f8c97;font-size:12px;">MESSAGE</p>
<p style="margin:0;color:#cfeaf2;white-space:pre-wrap;">${esc(message).replace(/\n/g, '<br>')}</p>
</td></tr>
<tr><td style="padding:12px 20px;border-top:1px solid #0b6a78;color:#6f8c97;font-size:12px;">Sent ${esc(when)} via SIGNAL LOST. Reply to this email to answer the sender.</td></tr>
</table></body></html>`;

  return {
    from: { name: 'SIGNAL LOST Beacon', address: user },
    to,
    replyTo: { name: name.replace(/[<>",;]/g, ''), address: email }, // reply goes to the visitor
    subject: `[SIGNAL LOST] ${subject}`,
    text,
    html,
  };
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT) || 465,
    secure: (process.env.EMAIL_PORT || '465') === '465',
    // Google shows App Passwords as "abcd efgh ijkl mnop": spaces are removed so either form works
    auth: { user: mailUser(), pass: mailPass() },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

const mailConfigured = () => Boolean(mailUser() && mailPass());

// ---------- the route ----------
router.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // 3. Honeypot: real visitors never see this field. Bots that fill it get a fake "success" and nothing is sent.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    console.warn('[contact] honeypot triggered, message dropped');
    return res.json({ ok: true });
  }

  // 4. Minimum time-to-submit
  const timing = checkTiming(req.get?.('x-form-opened') ?? req.headers?.['x-form-opened']);
  if (timing) return fail(res, 400, timing);

  // 5. Validation + sanitizing
  const { clean, errors } = validateContact(body);
  if (errors) return fail(res, 400, Object.values(errors)[0], errors);

  if (!mailConfigured()) {
    console.error('[contact] EMAIL_USER / EMAIL_PASS are not set in server/.env');
    return fail(res, 503, 'The comms relay is not configured yet. Please email me directly.');
  }

  // 6. Send
  try {
    await getTransporter().sendMail(buildMail(clean, { ip: req.ip }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[contact] send failed:', err?.code || '', err?.message || err);
    return fail(res, 502, 'The signal could not be relayed to Earth. Please try again later.');
  }
});

export default router;

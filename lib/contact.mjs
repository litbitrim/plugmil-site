import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export const RECIPIENT = 'litbitrim@gmail.com';
export const MAX_BODY_BYTES = 32768;
const SERVICES = new Map([
  ['website', 'Neue Website / Relaunch'],
  ['maintenance', 'Hosting / Betreuung'],
  ['support', 'Technische Hilfe'],
  ['automation', 'Automation / KI-Integration'],
  ['other', 'Anderes Projekt'],
]);
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class ContactError extends Error {
  constructor(status, code, retryAfter = 0) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function validateContact(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContactError(400, 'invalid_input');
  }
  const text = (key, min, max, singleLine = false) => {
    if (typeof body[key] !== 'string') throw new ContactError(400, 'invalid_input');
    const value = body[key].trim();
    if (value.length < min || value.length > max || CONTROL.test(value) ||
      (singleLine && /[\r\n\t]/.test(value))) {
      throw new ContactError(400, 'invalid_input');
    }
    return value;
  };
  if (body.website !== '' || body.privacy !== true || !UUID.test(body.requestId || '')) {
    throw new ContactError(400, 'invalid_input');
  }
  const name = text('name', 2, 120, true);
  const email = text('email', 3, 254, true);
  const message = text('message', 10, 5000);
  if (!EMAIL.test(email) || !SERVICES.has(body.service)) {
    throw new ContactError(400, 'invalid_input');
  }
  return { name, email, message, service: body.service, requestId: body.requestId.toLowerCase() };
}

export function getConfig(env) {
  const sender = env.CONTACT_FROM?.trim();
  const senderAddress = sender?.match(/<([^<>]+)>$/)?.[1] || sender;
  let redisUrl;
  try { redisUrl = new URL(env.UPSTASH_REDIS_REST_URL); } catch {}
  if (!env.RESEND_API_KEY || !sender || sender.length > 320 || /[\r\n\x00]/.test(sender) ||
    !EMAIL.test(senderAddress || '') || !redisUrl || redisUrl.protocol !== 'https:' ||
    !redisUrl.hostname.endsWith('.upstash.io') || redisUrl.username || redisUrl.password ||
    redisUrl.search || redisUrl.hash || redisUrl.pathname !== '/' || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new ContactError(503, 'service_unavailable');
  }
  return {
    sender,
    apiKey: env.RESEND_API_KEY,
    redisUrl: redisUrl.origin,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN,
    namespace: env.VERCEL_ENV === 'production' ? 'production' : 'preview',
  };
}

export function isAllowedOrigin(origin, env) {
  if (!origin || typeof origin !== 'string') return false;
  const allowed = new Set(['https://plugmil.dev', 'https://www.plugmil.dev']);
  // VERCEL_URL is injected by the platform for this exact deployment.
  if (env.VERCEL_URL && /^[a-z0-9.-]+\.vercel\.app$/i.test(env.VERCEL_URL)) {
    allowed.add(`https://${env.VERCEL_URL}`);
  }
  if (env.CONTACT_LOCAL_DEV === '1' && !env.VERCEL) {
    allowed.add('http://127.0.0.1:4173');
    allowed.add('http://localhost:4173');
  }
  return allowed.has(origin);
}

export function clientIp(req, env) {
  // Only trust Vercel's overwritten forwarding header on Vercel itself.
  const raw = env.VERCEL === '1'
    ? req.headers['x-vercel-forwarded-for']
    : req.socket?.remoteAddress;
  const value = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  if (!isIP(value)) throw new ContactError(503, 'service_unavailable');
  // Group IPv6 by /64 so privacy-address rotation does not reset the quota.
  if (isIP(value) === 6) {
    const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
    if (normalized.startsWith('::ffff:')) return normalized;
    const [left, right = ''] = normalized.split('::');
    const a = left ? left.split(':') : [];
    const b = right ? right.split(':') : [];
    const expanded = normalized.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
    return expanded.slice(0, 4).map(x => x.padStart(4, '0')).join(':') + '::/64';
  }
  return value;
}

// One atomic operation across IP, sender email and total website volume.
// A rejected request does not extend the window; every key has an expiry.
export const RATE_LUA = `
local retry = 0
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[(i - 1) * 2 + 1])
  local current = tonumber(redis.call('GET', key) or '0')
  if current >= limit then
    retry = math.max(retry, redis.call('TTL', key), 1)
  end
end
if retry > 0 then return {0, retry} end
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, tonumber(ARGV[(i - 1) * 2 + 2])) end
end
return {1, 0}
`;

export async function enforceRateLimit(config, ip, email, fetchImpl = fetch) {
  const hash = (kind, value) => createHmac('sha256', config.redisToken).update(`${kind}|${value}`).digest('hex');
  const prefix = `plugmil:contact:${config.namespace}`;
  let response, data;
  try {
    response = await fetchImpl(config.redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', RATE_LUA, 3,
        `${prefix}:ip:${hash('ip', ip)}`,
        `${prefix}:email:${hash('email', email.toLowerCase())}`,
        `${prefix}:global`, 5, 900, 3, 3600, 30, 3600]),
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    data = await response.json();
  } catch { throw new ContactError(503, 'service_unavailable'); }
  if (!response.ok || data.error || !Array.isArray(data.result) || data.result.length !== 2 ||
    ![0, 1].includes(data.result[0]) || !Number.isFinite(data.result[1])) {
    throw new ContactError(503, 'service_unavailable');
  }
  if (data.result[0] !== 1) throw new ContactError(429, 'rate_limited', Math.max(1, Math.min(3600, data.result[1])));
}

export async function sendContact(config, contact, fetchImpl = fetch) {
  const payload = {
    from: config.sender,
    to: [RECIPIENT],
    reply_to: contact.email,
    subject: `plugmil Anfrage · ${SERVICES.get(contact.service)}`,
    text: [
      'Neue Anfrage über plugmil.dev', '',
      `Anfrage-ID: ${contact.requestId}`,
      `Name / Firma: ${contact.name}`,
      `E-Mail: ${contact.email}`,
      `Leistung: ${SERVICES.get(contact.service)}`, '',
      contact.message,
    ].join('\n'),
  };
  let response, data;
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plugmil-contact:${contact.requestId}`,
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    data = await response.json();
  } catch { throw new ContactError(502, 'send_unconfirmed'); }
  if (!response.ok || typeof data.id !== 'string' || !data.id || data.id.length > 100) {
    throw new ContactError(502, 'send_unconfirmed');
  }
  return { status: 'accepted', requestId: contact.requestId, providerId: data.id };
}

export async function readJsonBody(req) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new ContactError(413, 'body_too_large');
  }
  if (req.body !== undefined) {
    let serialized;
    try { serialized = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body); }
    catch { throw new ContactError(400, 'invalid_input'); }
    if (serialized === undefined) throw new ContactError(400, 'invalid_input');
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new ContactError(413, 'body_too_large');
    try { return JSON.parse(serialized.toString()); } catch { throw new ContactError(400, 'invalid_json'); }
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new ContactError(413, 'body_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContactError(400, 'invalid_json'); }
}

export function createContactHandler({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    let requestId;
    try {
      if (!isAllowedOrigin(req.headers.origin, env)) throw new ContactError(403, 'origin_not_allowed');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        throw new ContactError(415, 'json_required');
      }
      const contact = validateContact(await readJsonBody(req));
      requestId = contact.requestId;
      const config = getConfig(env);
      await enforceRateLimit(config, clientIp(req, env), contact.email, fetchImpl);
      const result = await sendContact(config, contact, fetchImpl);
      logger.info('contact_accepted', { requestId, providerId: result.providerId });
      res.statusCode = 202;
      // The provider ID stays server-side. "accepted" does not assert inbox delivery.
      res.end(JSON.stringify({ status: result.status, requestId }));
    } catch (error) {
      const known = error instanceof ContactError;
      const status = known ? error.status : 503;
      const code = known ? error.code : 'service_unavailable';
      if (status >= 500) logger.warn('contact_failed', { requestId, code });
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.statusCode = status;
      res.end(JSON.stringify({ error: code }));
    }
  };
}

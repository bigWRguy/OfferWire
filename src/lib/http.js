// Resilient fetch: timeouts, retries with jitter, UA rotation, per-host politeness.
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];
const lastHit = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeWait(host, minGapMs) {
  const prev = lastHit.get(host) || 0;
  const wait = prev + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

export async function get(url, opts = {}) {
  const {
    tries = 3, timeoutMs = 20000, minGapMs = 900,
    headers = {}, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  } = opts;
  const host = new URL(url).host;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await politeWait(host, minGapMs);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': UAS[Math.floor(Math.random() * UAS.length)],
          accept,
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
      const h = res.headers;
      const meta = {
        status: res.status,
        // X returns these on every GraphQL call. They are the difference between a
        // scheduler that plans its budget and one that blindly burns it and gets 429'd
        // halfway through a sweep.
        rateLimit: h.get('x-rate-limit-limit') ? {
          limit: +h.get('x-rate-limit-limit'),
          remaining: +h.get('x-rate-limit-remaining'),
          resetAt: +h.get('x-rate-limit-reset') * 1000,
        } : null,
      };
      // 429 is NOT retryable here — retrying burns the next window too. Hand it back so
      // the caller can park this credential until reset and switch to another.
      if (res.status === 429) return { ok: false, ...meta, rateLimited: true, text: '' };
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, ...meta, text: '' };
      return { ok: true, ...meta, text: await res.text() };
    } catch (e) {
      lastErr = e;
      await sleep(600 * 2 ** i + Math.random() * 500);
    } finally { clearTimeout(t); }
  }
  return { ok: false, status: 0, text: '', error: String(lastErr) };
}

export async function getJson(url, opts = {}) {
  const r = await get(url, { accept: 'application/json,text/plain,*/*', ...opts });
  if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}`, data: null };
  try { return { ok: true, data: JSON.parse(r.text) }; }
  catch (e) { return { ok: false, error: 'bad json', data: null }; }
}

export { sleep };

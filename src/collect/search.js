import { sleep } from '../lib/http.js';

let _pw = null;
async function playwright() {
  if (!_pw) _pw = await import('playwright');
  return _pw;
}

const uaFor = (version) => process.env.OFFERWIRE_UA
  || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version).split('.')[0] || '141'}.0.0.0 Safari/537.36`;

const INTERSTITIAL = /performing security verification|security service to protect against malicious bots|verifying you are human|just a moment|checking your browser|enable javascript and cookies to continue/;
const CHALLENGE_MS = Number(process.env.OFFERWIRE_CHALLENGE_MS || 30000);
const PROXY = (process.env.OFFERWIRE_PROXY || '').trim();

export function loadCredentials() {
  const creds = [];
  if (process.env.X_SESSIONS) {
    for (const pair of process.env.X_SESSIONS.split(',')) {
      const [authToken, ct0] = pair.split(':').map((s) => s && s.trim());
      if (authToken && ct0) creds.push({ authToken, ct0, id: `s:${authToken.slice(0, 6)}` });
    }
  }
  if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
    const id = `s:${process.env.X_AUTH_TOKEN.slice(0, 6)}`;
    if (!creds.some((c) => c.id === id)) {
      creds.push({ authToken: process.env.X_AUTH_TOKEN, ct0: process.env.X_CT0, id });
    }
  }
  return creds;
}

export const configured = () => loadCredentials().length > 0;

function harvest(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) harvest(n, out, seen); return out; }
  const legacy = node.legacy;
  if (legacy && legacy.full_text && (node.rest_id || legacy.id_str)) {
    const id = node.rest_id || legacy.id_str;
    if (!seen.has(id)) {
      seen.add(id);
      const u = node.core?.user_results?.result || {};
      const ul = u.legacy || {};
      const uc = u.core || {};
      const bio = u.profile_bio || {};
      const t = new Date(legacy.created_at);
      if (!Number.isNaN(t.getTime())) {
        out.push({
          id,
          text: node.note_tweet?.note_tweet_results?.result?.text || legacy.full_text,
          author: String(uc.screen_name || ul.screen_name || '').toLowerCase(),
          authorName: uc.name || ul.name || '',
          authorBio: (bio.description || ul.description || '').replace(/\s+/g, ' ').trim() || null,
          authorLocation: (u.location?.location || ul.location || '') || null,
          authorFollowers: ul.followers_count ?? null,
          authorVerified: !!(u.is_blue_verified || ul.verified),
          createdAt: t.toISOString(),
          mentions: (legacy.entities?.user_mentions || []).map((m) => String(m.screen_name).toLowerCase()),
          mentioned: (legacy.entities?.user_mentions || []).map((m) => ({
            handle: String(m.screen_name || '').toLowerCase(),
            name: m.name || null,
          })).filter((m) => m.handle),
          hashtags: (legacy.entities?.hashtags || []).map((h) => h.text),
          links: (legacy.entities?.urls || []).map((x) => x.expanded_url).filter(Boolean),
          hasMedia: !!(legacy.extended_entities?.media?.length || legacy.entities?.media?.length),
          isRetweet: /^RT @/.test(legacy.full_text),
          source: 'x',
        });
      }
    }
  }
  for (const v of Object.values(node)) harvest(v, out, seen);
  return out;
}

export class SearchSession {
  constructor(cred, opts = {}) {
    this.cred = cred;
    this.headless = opts.headless !== false;
    this.browser = null;
    this.page = null;
    this.captured = [];
    this.timelineResponses = 0;
    this.timelineParseErrors = 0;
    this.timelineStatuses = [];
    this.rateLimited = false;
    this.loggedOut = false;
    this.requests = 0;
    this.challengesSeen = 0;
    this.challengeStuck = false;
  }

  async open() {
    const { chromium } = await playwright();
    this.browser = await chromium.launch({
      channel: 'chromium',
      headless: this.headless,
      ...(PROXY ? { proxy: { server: PROXY } } : {}),
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await this.browser.newContext({
      userAgent: uaFor(this.browser.version()),
      viewport: { width: 1280, height: 2400 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    await ctx.addCookies([
      { name: 'auth_token', value: this.cred.authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true },
      { name: 'ct0', value: this.cred.ct0, domain: '.x.com', path: '/', secure: true },
    ]);
    await ctx.route('https://*.twimg.com/**', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = await ctx.newPage();
    this.page.on('response', async (res) => {
      if (!res.url().includes('SearchTimeline')) return;
      this.timelineResponses++;
      this.timelineStatuses.push(res.status());
      if (res.status() === 429) { this.rateLimited = true; return; }
      if (res.status() !== 200) return;
      try { this.captured.push(await res.json()); } catch { this.timelineParseErrors++; }
    });
    return this;
  }

  async warmUp() {
    try {
      await this.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.waitForTimeout(700);
      await this.passInterstitial(CHALLENGE_MS * 2);
    } catch {}
    return this;
  }

  async close() { try { await this.browser?.close(); } catch {} }

  async diagnose() {
    let title = '', text = '';
    try {
      title = await this.page.title();
      text = (await this.page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch (e) {
      return { label: `page unreadable: ${e.message}` };
    }
    const hay = `${title} ${text}`.toLowerCase();
    const has = (...needles) => needles.some((n) => hay.includes(n));
    const snippet = text.slice(0, 160) || `(blank page, title "${title}")`;
    if (has('sign in to x', 'sign up for x', 'log in to x', 'to view keyword searches', "don't miss what's happening", 'create your account'))
      return { loggedOut: true, label: `login wall: ${snippet}`, snippet };
    if (has('account has been locked', 'suspended', 'unusual activity', 'verify your identity', 'confirm your identity'))
      return { loggedOut: true, label: `account challenged: ${snippet}`, snippet };
    if (has('rate limit exceeded', 'try again later', 'too many requests'))
      return { rateLimited: true, label: `rate limit page: ${snippet}`, snippet };
    if (has('something went wrong'))
      return { label: `X error page: ${snippet}`, snippet };
    if (INTERSTITIAL.test(hay))
      return { challenge: true, label: `bot-check interstitial did not clear: ${snippet}`, snippet };
    return { label: `no timeline call; page said: ${snippet}`, snippet };
  }

  async onInterstitial() {
    try {
      const hay = ((await this.page.title()) + ' ' + await this.page.evaluate(() => document.body?.innerText || '')).toLowerCase();
      return INTERSTITIAL.test(hay);
    } catch { return false; }
  }

  async passInterstitial(budgetMs = CHALLENGE_MS) {
    if (!await this.onInterstitial()) return false;
    this.challengesSeen++;
    const started = Date.now();
    const deadline = started + budgetMs;
    let reloaded = false;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1000);
      if (this.timelineResponses) return true;
      if (!await this.onInterstitial()) return true;
      if (!reloaded && Date.now() - started > budgetMs / 2) {
        reloaded = true;
        try { await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
      }
    }
    this.challengeStuck = true;
    return true;
  }

  async search(query, { scrolls = 0, settleMs = 7000, challengeMs = CHALLENGE_MS } = {}) {
    if (!this.page) throw new Error('session not opened');
    this.captured = [];
    this.timelineResponses = 0;
    this.timelineStatuses = [];
    this.rateLimited = false;
    this.timelineParseErrors = 0;
    this.challengeStuck = false;

    const url = 'https://x.com/search?q=' + encodeURIComponent(query) + '&f=live&src=typed_query';
    const firstTimeline = this.page.waitForResponse((r) => r.url().includes('SearchTimeline'), { timeout: settleMs })
      .catch(() => null);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      return { ok: false, posts: [], error: `navigation: ${e.message}` };
    }
    this.requests++;

    await firstTimeline;
    await this.page.waitForTimeout(700);

    if (!this.timelineResponses && await this.passInterstitial(challengeMs)) {
      const afterChallenge = this.page.waitForResponse((r) => r.url().includes('SearchTimeline'), { timeout: settleMs })
        .catch(() => null);
      await afterChallenge;
      await this.page.waitForTimeout(700);
      if (!this.timelineResponses && !this.challengeStuck) {
        const afterReload = this.page.waitForResponse((r) => r.url().includes('SearchTimeline'), { timeout: settleMs })
          .catch(() => null);
        try { await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
        await afterReload;
        await this.page.waitForTimeout(700);
      }
    }

    if (this.page.url().includes('/login') || this.page.url().includes('/i/flow/login')) {
      this.loggedOut = true;
      return { ok: false, posts: [], error: 'session expired (redirected to login)' };
    }
    if (this.rateLimited) return { ok: false, posts: [], error: 'rate limited', rateLimited: true };
    if (!this.timelineResponses) {
      const d = await this.diagnose();
      if (d.loggedOut) {
        this.loggedOut = true;
        return { ok: false, posts: [], error: `session expired — ${d.label}` };
      }
      if (d.rateLimited) {
        this.rateLimited = true;
        return { ok: false, posts: [], error: `rate limited — ${d.label}`, rateLimited: true };
      }
      return { ok: false, posts: [], error: `SearchTimeline response missing — ${d.label} (slice left pending)`, challengeStuck: !!d.challenge };
    }
    if (!this.timelineStatuses.includes(200)) {
      return { ok: false, posts: [], error: `SearchTimeline HTTP ${this.timelineStatuses.join(',')} (slice left pending)` };
    }
    if (this.timelineParseErrors && !this.captured.length) {
      return { ok: false, posts: [], error: 'SearchTimeline JSON unreadable (slice left pending)' };
    }

    for (let i = 0; i < scrolls; i++) {
      const before = this.captured.length;
      const nextTimeline = this.page.waitForResponse((r) => r.url().includes('SearchTimeline'), { timeout: 6000 })
        .catch(() => null);
      await this.page.mouse.wheel(0, 4000);
      this.requests++;
      if (!await nextTimeline) break;
      await this.page.waitForTimeout(700);
      if (this.rateLimited) break;
      if (this.captured.length === before) break;
    }

    if (this.rateLimited) {
      return { ok: false, posts: [], error: 'rate limited during pagination (slice left pending)', rateLimited: true };
    }
    const seen = new Set();
    const posts = [];
    for (const blob of this.captured) posts.push(...harvest(blob, [], seen));
    return { ok: true, posts: posts.map((p) => ({ ...p, via: `search:${query.slice(0, 40)}` })) };
  }
}

const withSince = (query, sinceMs) => `${query} since_time:${Math.floor(sinceMs / 1000)}`;

export function liveWindowQuery(job, mark, nowMs, overlapMs = 5 * 60e3) {
  const active = mark.window && !mark.window.completed ? mark.window : null;
  const lowerMs = active ? new Date(active.lower).getTime() : Math.max(0, (mark.at ? new Date(mark.at).getTime() : nowMs - 2 * 3600e3) - overlapMs);
  const upperMs = active ? new Date(active.upper).getTime() : nowMs;
  const untilMs = active?.until_time ? new Date(active.until_time).getTime() : upperMs;
  return { query: `${withSince(job.query, lowerMs)} until_time:${Math.floor(untilMs / 1000)}`, window: { lower: new Date(lowerMs).toISOString(), upper: new Date(upperMs).toISOString(), until_time: new Date(untilMs).toISOString() } };
}
export function advanceLiveWindow(mark, window, posts, truncated) {
  mark.lastPosts = posts.length;
  if (truncated && posts.length) {
    const oldest = Math.min(...posts.map((p) => new Date(p.createdAt).getTime()).filter(Number.isFinite));
    if (Number.isFinite(oldest)) { mark.window = { ...window, until_time: new Date(Math.max(new Date(window.lower).getTime(), oldest - 1000)).toISOString(), completed: false }; mark.truncated = true; return false; }
  }
  mark.at = window.upper; mark.truncated = false; delete mark.window; return true;
}

export function prioritizeJobs(jobs, marks = {}, backfillShare = 0.25) {
  const byAge = (a, b) => {
    const am = marks[a.key]?.at ? new Date(marks[a.key].at).getTime() : 0;
    const bm = marks[b.key]?.at ? new Date(marks[b.key].at).getTime() : 0;
    if (am !== bm) return am - bm;
    return (b.priority || 0) - (a.priority || 0);
  };
  const live = jobs.filter((j) => !j.fixedWindow).sort(byAge);
  const history = jobs.filter((j) => j.fixedWindow).sort(byAge);
  if (!history.length) return live;

  const share = Math.min(0.8, Math.max(0.1, Number(backfillShare || 0.25)));
  const ordered = [];
  let li = 0, hi = 0, credit = 0;
  while (li < live.length || hi < history.length) {
    credit += share;
    if (hi < history.length && (credit >= 1 || li >= live.length)) {
      ordered.push(history[hi++]);
      credit -= 1;
    } else if (li < live.length) ordered.push(live[li++]);
    else ordered.push(history[hi++]);
  }
  return ordered;
}

export async function sweep(jobs, state, {
  budgetPerCred = Number(process.env.OFFERWIRE_REQUESTS_PER_CRED || 30),
  scrolls = Number(process.env.OFFERWIRE_SCROLLS || 1),
  headless = true,
  log = () => {},
} = {}) {
  const creds = loadCredentials();
  if (!creds.length) return { ok: false, reason: 'no-credentials', posts: [], swept: 0, jobs: jobs.length };

  const marks = (state.watermarks ||= {});
  const now = Date.now();
  const backfillShare = Math.min(0.8, Math.max(0.1, Number(process.env.OFFERWIRE_BACKFILL_SHARE || 0.25)));
  const ordered = prioritizeJobs(jobs, marks, backfillShare);

  const all = [];
  const errors = [];
  let swept = 0, failed = 0, cursor = 0, requests = 0;
  const sweptByKind = {};
  const requestsByKind = {};

  for (const cred of creds) {
    if (cursor >= ordered.length) break;
    const session = new SearchSession(cred, { headless });
    try {
      await session.open();
      await session.warmUp();
      log(`  search: session ${cred.id} open${session.challengesSeen ? (session.challengeStuck ? ' (bot check did NOT clear)' : ' (cleared a bot check)') : ''}`);
      let spent = 0;
      let stuck = 0;

      while (cursor < ordered.length && spent < budgetPerCred) {
        const job = ordered[cursor];
        const since = marks[job.key]?.at;
        const sinceMs = since ? new Date(since).getTime() : now - 12 * 3600e3;
        const fixedCursor = job.fixedWindow && marks[job.key]?.cursorUntil;
        const live = !job.fixedWindow ? liveWindowQuery(job, marks[job.key] || {}, now) : null;
        const query = job.fixedWindow
          ? `${job.query}${fixedCursor ? ` until_time:${Math.floor(new Date(fixedCursor).getTime() / 1000)}` : ''}`
          : live.query;
        const beforeRequests = session.requests;
        const res = await session.search(query, { scrolls });
        const jobRequests = session.requests - beforeRequests;
        requestsByKind[job.kind] = (requestsByKind[job.kind] || 0) + jobRequests;
        spent = session.requests;
        cursor++;

        if (!res.ok) {
          failed++;
          if (errors.length < 8) errors.push(`${job.key}: ${res.error}`);
          if (res.rateLimited) { log(`  search: ${cred.id} rate limited after ${swept} jobs`); break; }
          if (session.loggedOut) { log(`  search: ${cred.id} SESSION EXPIRED — refresh its cookies`); break; }
          if (res.challengeStuck && ++stuck >= 3) {
            log(`  search: ${cred.id} BLOCKED — X's bot check will not clear for this session`);
            break;
          }
          continue;
        }

        all.push(...res.posts.map((p) => ({ ...p, searchJob: job.key, searchKind: job.kind, searchedSchoolId: job.schoolId || (job.kind === 'school' ? job.key : null) })));
        swept++;
        stuck = 0;
        sweptByKind[job.kind] = (sweptByKind[job.kind] || 0) + 1;

        const m = (marks[job.key] ||= {});
        if (job.fixedWindow) {
          m.at = new Date(now).toISOString();
          m.lastPosts = res.posts.length;
          m.truncated = res.posts.length >= 18 * (1 + scrolls);
          if (m.truncated && res.posts.length) {
            const oldest = Math.min(...res.posts.map((p) => new Date(p.createdAt).getTime()));
            m.cursorUntil = new Date(oldest).toISOString();
            m.completed = false;
          } else {
            m.completed = true;
            delete m.cursorUntil;
          }
          await sleep(900 + Math.random() * 900);
          continue;
        }
        const truncated = res.posts.length >= 18 * (1 + scrolls);
        advanceLiveWindow(m, live.window, res.posts, truncated);

        await sleep(900 + Math.random() * 900);
      }
    } catch (e) {
      errors.push(`session ${cred.id}: ${e.message}`);
    } finally {
      requests += session.requests;
      await session.close();
    }
  }

  log(`  search: swept ${swept}/${jobs.length} jobs, ${all.length} posts, ${failed} failed`);
  for (const e of errors) log(`    ! ${e}`);

  const ok = swept > 0 || jobs.length === 0;
  const rateLimited = errors.some((e) => /rate limited/i.test(e));
  const expired = errors.some((e) => /session expired/i.test(e));
  const blocked = !ok && errors.some((e) => /bot-check interstitial did not clear/i.test(e));
  return {
    ok,
    transient: !ok && (rateLimited || blocked) && !expired,
    blocked,
    rateLimited,
    expired,
    reason: ok ? null : (errors[0] || 'all search jobs failed'),
    posts: all, swept, jobs: jobs.length, failed, errors, requests,
    sweptByKind, requestsByKind,
    coverageCycles: Math.max(1, Math.ceil(jobs.length / Math.max(1, swept))),
  };
}

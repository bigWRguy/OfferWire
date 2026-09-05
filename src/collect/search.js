// ============================================================================
// X SEARCH — the engine.
//
// Per-school targeted search, driven through a real browser.
//
// WHY A BROWSER. X gates SearchTimeline behind a per-request signed header
// (`x-client-transaction-id`, computed in their JS from the page's
// twitter-site-verification key plus the loading-x-anim SVG frames). Measured
// 2026-08-27 on one session, same cookies, same minute:
//
//     UserTweets      -> 200, 218KB of posts
//     SearchTimeline  -> 404, empty      (unsigned)
//     SearchTimeline  -> 404, empty      (dummy signatures, several lengths)
//
// Rather than forge that signature, we run X's own client and let it sign its own
// requests, then read the JSON off the wire. Same data, full fidelity, no
// reimplementation of anything X protects — and nothing to repair when they rotate the
// algorithm, because we never depended on it.
//
// Verified working: query "(@AlabamaFTBL OR \"Alabama\") (offer OR offered)
// -filter:retweets" returned 20 posts including a 2028 RB's own announcement
// ("#AGTG ... blessed to receive an offer from Unive[rsity of Alabama]") plus two
// independent reporter posts on the same offer.
//
// COST. One browser process, reused across every query in a run. Navigation per query,
// scroll for extra pages. Rate limits are X's usual ~50 SearchTimeline calls per
// 15-minute window per account, which is what scripts/coverage.mjs plans against.
// ============================================================================
import { sleep } from '../lib/http.js';

let _pw = null;
async function playwright() {
  if (!_pw) _pw = await import('playwright');
  return _pw;
}

// The user agent must agree with the browser actually running, or the bot check fails
// before it starts. The old value claimed Windows + Chrome 125 while the runner served
// Linux client hints from a headless build — a mismatch no real browser produces. Keep
// the real platform and the real version; the only edit is hiding the headless build,
// which the shipped UA string announces outright.
const uaFor = (version) => process.env.OFFERWIRE_UA
  || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version).split('.')[0] || '141'}.0.0.0 Safari/537.36`;

/** X's bot-check holding page. Its own words, not ours — see passInterstitial(). */
const INTERSTITIAL = /performing security verification|security service to protect against malicious bots|verifying you are human|just a moment|checking your browser|enable javascript and cookies to continue/;
/** How long the holding page is allowed to clear before the job is given up on. */
const CHALLENGE_MS = Number(process.env.OFFERWIRE_CHALLENGE_MS || 30000);

/** Credentials. Several sessions can be pooled to multiply the sweep budget. */
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

/** Structure-agnostic harvest; survives X reshaping the payload. */
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
          // The author's bio is gold for recruit identification — it routinely carries
          // "C/O 2028 | WR | 6'2 185 | Some HS", which is class, position, size and
          // school for free, straight off the offer post.
          authorBio: (bio.description || ul.description || '').replace(/\s+/g, ' ').trim() || null,
          authorLocation: (u.location?.location || ul.location || '') || null,
          authorFollowers: ul.followers_count ?? null,
          authorVerified: !!(u.is_blue_verified || ul.verified),
          createdAt: t.toISOString(),
          mentions: (legacy.entities?.user_mentions || []).map((m) => String(m.screen_name).toLowerCase()),
          // X gives the DISPLAY NAME of every tagged account, not just the handle. When a
          // reporter writes "2028 RB Jayshawn Mitchell (@JAYMITCH_1) picks up an offer",
          // the recruit's real name is already in the payload — no name-guessing from
          // prose required. This is what lets the wire work without an LLM.
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

/** A live browser session bound to one credential. */
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
      // `channel: 'chromium'` is what gets the FULL browser in new headless mode.
      // Plain `headless: true` launches Playwright's headless shell, a stripped build
      // that fails X's bot check on fingerprint alone and never reaches a timeline.
      channel: 'chromium',
      headless: this.headless,
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
    // Images and media are the bulk of the bytes and none of the signal. Scope the
    // interception to the CDN that actually serves them: a '**/*' route puts an
    // interceptor in front of every request on the page, including the bot check's own,
    // and both the blocked assets and the added latency are things it can score. Nothing
    // on x.com itself is intercepted any more.
    await ctx.route('https://*.twimg.com/**', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    // navigator.webdriver is the first thing every bot check reads.
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

  /**
   * Take the bot check on a page that costs nothing, so no search job pays for it.
   *
   * The clearance is a context cookie: pass it once here and every query afterwards
   * navigates straight into a timeline. Failing this is not fatal — a search can still
   * sit through a challenge of its own — so it never throws.
   */
  async warmUp() {
    try {
      await this.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.waitForTimeout(700);
      // Be generous HERE and nowhere else. This is paid once per run, while the same
      // patience inside a search job is multiplied by the job count, and clearing it
      // here means no job meets the check at all.
      await this.passInterstitial(CHALLENGE_MS * 2);
    } catch {}
    return this;
  }

  async close() { try { await this.browser?.close(); } catch {} }

  /**
   * Why did the page never call SearchTimeline?
   *
   * "response missing" on its own is unactionable — it looks identical whether the
   * cookies died, the account got locked, X threw an interstitial, or the runner was
   * simply slow. X does NOT redirect a dead session away from /search any more; it
   * renders a login wall at the same URL, so a URL check alone reports nothing. Read
   * what the page actually says, once per session, and name the failure.
   */
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

  /** Is the bot-check interstitial on screen right now? */
  async onInterstitial() {
    try {
      const hay = ((await this.page.title()) + ' ' + await this.page.evaluate(() => document.body?.innerText || '')).toLowerCase();
      return INTERSTITIAL.test(hay);
    } catch { return false; }
  }

  /**
   * Sit through X's bot-check interstitial.
   *
   * X started serving "Performing security verification" ahead of x.com on this runner's
   * IP range. It is a passive check that clears itself and then loads the real page, but
   * it costs far more than the settle budget a normal search is given, so every query
   * timed out on the holding page and reported an empty timeline. Waiting it out once
   * banks the clearance cookie in this browser context and the rest of the run is normal.
   *
   * @returns {boolean} whether a challenge was seen (and therefore whether the caller
   *                    should give the timeline another chance to fire)
   */
  async passInterstitial(budgetMs = CHALLENGE_MS) {
    if (!await this.onInterstitial()) return false;
    this.challengesSeen++;
    const started = Date.now();
    const deadline = started + budgetMs;
    let reloaded = false;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1000);
      if (this.timelineResponses) return true;      // it cleared straight into the timeline
      if (!await this.onInterstitial()) return true;
      // A check that has sat still for half the budget is stalled rather than working.
      // One reload is the cheapest thing that has ever unstuck one.
      if (!reloaded && Date.now() - started > budgetMs / 2) {
        reloaded = true;
        try { await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
      }
    }
    this.challengeStuck = true;
    return true;
  }

  /**
   * Run one query. `scrolls` fetches additional pages — each scroll triggers another
   * signed SearchTimeline call, so it costs budget like any other request.
   */
  async search(query, { scrolls = 0, settleMs = 7000, challengeMs = CHALLENGE_MS } = {}) {
    if (!this.page) throw new Error('session not opened');
    this.captured = [];
    this.timelineResponses = 0;
    this.timelineStatuses = [];
    this.rateLimited = false;
    this.timelineParseErrors = 0;
    this.challengeStuck = false;

    const url = 'https://x.com/search?q=' + encodeURIComponent(query) + '&f=live&src=typed_query';
    // Arm the waiter BEFORE navigation. The old code attached it after goto(), so fast
    // responses were routinely missed and every query paid the full timeout. Worse, a
    // page that never called SearchTimeline looked like a legitimate empty result and
    // caused a historical slice to be marked complete forever.
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

    // A bot check swallows the whole settle budget on the holding page. Wait it out and
    // give the timeline a second, full-length chance rather than calling the query dead.
    if (!this.timelineResponses && await this.passInterstitial(challengeMs)) {
      const afterChallenge = this.page.waitForResponse((r) => r.url().includes('SearchTimeline'), { timeout: settleMs })
        .catch(() => null);
      await afterChallenge;
      await this.page.waitForTimeout(700);
      // Some challenges land on x.com rather than bouncing back to the query. One reload
      // on a now-cleared context is cheap; the alternative is discarding the whole job.
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
      if (this.captured.length === before) break; // no more pages
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

/** X search understands epoch-second bounds; this is what makes sweeps incremental. */
const withSince = (query, sinceMs) => `${query} since_time:${Math.floor(sinceMs / 1000)}`;

/** Freeze a live interval before paging it.  A busy query must page backward
 * through the same upper bound instead of rereading its newest page forever. */
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

/**
 * Oldest live work stays first, but historical work receives a predictable fraction
 * of the window instead of racing a second workflow for the same credential quota.
 */
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

/**
 * Sweep jobs oldest-watermark-first, spending until the request budget runs out.
 *
 * Jobs not reached this cycle keep their older watermark and go first next cycle with a
 * correspondingly wider window, so COVERAGE IS COMPLETE at any budget — pool size and
 * cadence buy latency, never completeness. A truncated job advances its watermark only
 * as far as it actually read, never to "now".
 *
 * @param {Array}  jobs  [{ key, query, priority }]
 * @param {object} state persisted state (watermarks live here)
 */
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
        const sinceMs = since ? new Date(since).getTime() : now - 12 * 3600e3; // cold start: 12h
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
          // A bot check this session cannot pass will not pass on the next job either,
          // and each attempt costs the full challenge budget. Three is enough to know.
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
        // A full page leaves this frozen window pending; its watermark advances only after every page is covered.
        const truncated = res.posts.length >= 18 * (1 + scrolls);
        advanceLiveWindow(m, live.window, res.posts, truncated);

        await sleep(900 + Math.random() * 900); // human-ish pacing
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
  // Being rate limited is NORMAL — it is what a fully-spent budget looks like, and it
  // happens on every run once the pool is saturated. It must not be reported the same
  // way as a broken engine, or the scheduler cries wolf on healthy runs and the real
  // failure (expired cookies) gets lost in the noise.
  const rateLimited = errors.some((e) => /rate limited/i.test(e));
  const expired = errors.some((e) => /session expired/i.test(e));
  // A bot check is environmental, not a broken setup: it is applied per runner address
  // and comes and goes between runs on the same credential. Report it in its own right
  // so the caller can wait for the next run instead of declaring the engine dead.
  const blocked = !ok && errors.some((e) => /bot-check interstitial did not clear/i.test(e));
  return {
    ok,
    // `transient` says: nothing is wrong with the setup, we simply ran out of budget.
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

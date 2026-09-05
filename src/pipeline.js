// The wire. One run = collect -> prefilter -> extract -> resolve -> merge -> publish.
//
// Everything is idempotent and restartable: state lives in data/, nothing is held in
// memory across runs, and a crash mid-run loses at most the current cycle (which the
// next cycle re-covers, because every reader deliberately overlaps its window).
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, appendNdjson, readNdjson, sha1, decodeEntities, DATA, CONFIG } from './lib/store.js';
import { fetchList, fetchProfile, lagHours } from './collect/x.js';
import { sweep, configured as searchConfigured, loadCredentials } from './collect/search.js';
import { allJobs, schoolJobs, backfillJobs, backfillAnchorDate, backfillProgress } from './collect/queries.js';
import { classify, findClassYear, findPosition, findTaggedRecruit, findReportedName, handleClassYear } from './extract/rules.js';
import { findSchools, byId, HANDLES, SCHOOLS, explicitNonFbsOfferTarget } from './resolve/schools.js';
import { decorateOffers } from './resolve/tiers.js';
import { resolveOfferTarget, seedDisplayAffiliations } from './resolve/attribution.js';
import { indexPlayers, resolve as resolvePlayer, mergeInto, nameKey, fuzzyKey, parseBio, looksLikeRecruit, cleanPersonName } from './resolve/players.js';
import * as watch from './watchlist.js';

const now = () => new Date().toISOString();
const cfg = (f) => JSON.parse(fs.readFileSync(path.join(CONFIG, f), 'utf8'));

const auditReject = (audit, stage, reason, post = null) => {
  const bucket = (audit[stage] ??= { accepted: 0, rejected: 0, reasons: {}, samples: [] });
  bucket.rejected++;
  bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1;
  if (post && bucket.samples.length < 24) {
    bucket.samples.push({
      reason,
      postId: post.id || null,
      author: post.author || null,
      searchJob: post.searchJob || null,
      text: String(post.text || '').replace(/\s+/g, ' ').slice(0, 240),
    });
  }
};

// Historical collection is opt-in through OFFERWIRE_BACKFILL_DAYS. The manual backfill workflow sets this to 30; ordinary live runs leave it at 0.
const BACKFILL_DAYS = Math.max(0, Math.floor(Number(process.env.OFFERWIRE_BACKFILL_DAYS || 0)));
// The backfill window is anchored to an early run, but draining 30 days x 136 schools
// takes days at the live pipe's history share. The old cap — BACKFILL_DAYS+1 days FROM
// NOW — silently discarded any post older than that the moment it arrived, so the oldest
// day of an anchored window (which oldest-first backfill sweeps FIRST) aged out before
// the sweep ever reached the days that were still worth having: the drain "ran" while the
// ledger gained nothing. BACKFILL_GRACE_DAYS stretches the cut so the WHOLE anchored
// window stays eligible for the entire drain, no matter how slowly the pipe is running.
const BACKFILL_GRACE_DAYS = Math.max(0, Number(process.env.OFFERWIRE_BACKFILL_GRACE_DAYS || 15));
// How many runs in a row may be turned away by X's bot check before it stops counting as
// weather. At four runs an hour this is roughly an hour and a half of silence.
const BLOCKED_RUNS_BEFORE_FAILING = Math.max(1, Number(process.env.OFFERWIRE_BLOCKED_RUNS_BEFORE_FAILING || 6));
const RECENCY_HOURS = Math.max(
  Number(process.env.OFFERWIRE_RECENCY_HOURS || 96),
  BACKFILL_DAYS ? (BACKFILL_DAYS + BACKFILL_GRACE_DAYS) * 24 : 0,
);

/** Schools whose per-school sweep watermark has fallen behind, worst first. */
function liveStaleness(state) {
  const values = schoolJobs().map((j) => { const at = state.watermarks?.[j.key]?.at; return at ? (Date.now() - new Date(at).getTime()) / 36e5 : Infinity; }).sort((a, b) => a - b);
  const p = (n) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * n))] : null;
  return { medianHours: p(.5), p95Hours: p(.95), worstHours: p(1) };
}

function staleSchools(state, thresholdHours = 2) {
  const marks = state.watermarks || {};
  return schoolJobs()
    .map((j) => {
      const at = marks[j.key]?.at;
      return { id: j.key, hours: at ? +((Date.now() - new Date(at).getTime()) / 36e5).toFixed(1) : Infinity };
    })
    .filter((s) => s.hours > thresholdHours)
    .sort((a, b) => b.hours - a.hours);
}

// ---------------------------------------------------------------------------
// 1. COLLECT
// ---------------------------------------------------------------------------
async function collect(state, log, audit) {
  const mode = String(process.env.OFFERWIRE_MODE || 'live').toLowerCase();
  const lists = cfg('lists.json');
  const accounts = cfg('accounts.json');
  const seen = new Set(state.seenPostIds || []);
  const fresh = [];
  const health = (state.health ??= {});

  const push = (posts, srcKey) => {
    let added = 0;
    const stats = audit.collection;
    stats.returned += posts.length;
    for (const p of posts) {
      if (!p.id) {
        stats.invalid++;
        continue;
      }
      if (seen.has(p.id)) {
        stats.duplicate++;
        continue;
      }
      const created = new Date(p.createdAt).getTime();
      if (!Number.isFinite(created)) {
        stats.invalid++;
        continue;
      }
      const age = (Date.now() - created) / 36e5;
      if (age > RECENCY_HOURS) { stats.tooOld++; continue; }
      if (age < -2) { stats.future++; continue; } // -2h tolerates clock skew
      seen.add(p.id);
      fresh.push(p);
      added++;
      stats.kept++;
    }
    health[srcKey] = { at: now(), got: posts.length, new: added, lag: posts.length ? +lagHours(posts).toFixed(2) : null };
    return added;
  };

  // --- Search: THE ENGINE -----------------------------------------------
  // Per-school sweep first, because it is the only reader that can surface a recruit
  // nobody has posted about from an account we already follow.
  if (!searchConfigured()) {
    // Not a degraded mode — a broken one. Say so unmistakably and fail the run so the
    // scheduler surfaces it, rather than committing a ledger that only looks healthy.
    log('');
    log('  !! SEARCH IS NOT CONFIGURED — THE WIRE CANNOT DO ITS JOB.');
    log('  !! Per-school search is the engine of this system. Without a credential the');
    log('  !! only thing running is corroboration of posts from accounts you already');
    log('  !! follow, which is exactly the coverage the recruiting services already have.');
    log('  !! Set X_AUTH_TOKEN + X_CT0 (or X_SESSIONS). See README.');
    log('');
    state.searchConfigured = false;
  } else {
    const days = BACKFILL_DAYS;
    const backfillSchools = new Set(String(process.env.OFFERWIRE_BACKFILL_SCHOOLS || '').split(',').map((id) => id.trim()).filter(Boolean));
    const historicalPlan = (days ? backfillJobs(days, backfillAnchorDate(state)) : [])
      .filter((job) => !backfillSchools.size || backfillSchools.has(job.schoolId));
    const historical = historicalPlan.filter((job) => !state.watermarks?.[job.key]?.completed);
    // A manual backfill spends its entire X-search budget on the historical backlog; live runs retain their normal coverage and can optionally interleave history.
    const jobs = mode === 'backfill' ? historical : [...allJobs(), ...historical];
    if (days) log(`  backfill: ${historical.length}/${historicalPlan.length} school-windows remaining`);
    const res = await sweep(jobs, state, { log });
    audit.search = {
      ok: res.ok,
      reason: res.reason || null,
      jobs: res.jobs,
      swept: res.swept,
      failed: res.failed,
      requests: res.requests,
      errors: (res.errors || []).slice(0, 8),
    };
    if (!res.ok && res.blocked) {
      // X's bot check is served per runner address and comes and goes between runs on the
      // same credential — one run sweeps 28 schools and the next is turned away at the
      // door. Nothing is lost: watermarks are untouched and the next run asks for a wider
      // window. Failing the build on one of these would mail out on every occurrence and
      // train the alarm to be ignored, which is worse than the block.
      //
      // A block that never lifts IS the engine being dead, so count consecutive ones and
      // stop being patient after BLOCKED_RUNS_BEFORE_FAILING (~1.5h of runs).
      state.blockedRuns = (state.blockedRuns || 0) + 1;
      state.lastBlockedAt = now();
      const fatal = state.blockedRuns >= BLOCKED_RUNS_BEFORE_FAILING;
      log(`  search: turned away by X's bot check — nothing swept (${state.blockedRuns} run(s) in a row).`);
      if (fatal) {
        log('  !! SEARCH IS BLOCKED AND STAYING BLOCKED.');
        log('  !! X has been refusing this session for long enough that it is not weather.');
        log('  !! Check the fingerprint rules in src/collect/search.js, or move the run off');
        log('  !! GitHub-hosted runners — their addresses are what the check scores.');
      } else {
        log('  search: this clears on its own between runs; waiting for the next one.');
      }
      state.searchConfigured = !fatal;
    } else if (!res.ok && res.transient) {
      // Budget exhausted, not broken. Watermarks are untouched for everything we did not
      // reach, so the next run simply asks for a wider window. Nothing is lost.
      log(`  search: rate limited with no budget left this window — nothing swept.`);
      log('  search: this is normal once the pool is saturated; add sessions to raise throughput.');
      state.searchConfigured = true;
      state.lastRateLimitAt = now();
    } else if (!res.ok) {
      log(`  !! SEARCH FAILED: ${res.reason}`);
      if (res.expired) log('  !! The session cookies have expired. Refresh X_AUTH_TOKEN / X_CT0.');
      state.searchConfigured = false;
    } else {
      const n = push(res.posts, 'search');
      log(`  search: ${n} new posts kept (of ${res.posts.length} returned)`);
      state.searchConfigured = true;
      state.blockedRuns = 0;
      const liveJobs = allJobs().length;
      const liveSwept = Object.entries(res.sweptByKind || {})
        .filter(([kind]) => kind !== 'backfill')
        .reduce((sum, [, count]) => sum + count, 0);
      const liveRequests = Object.entries(res.requestsByKind || {})
        .filter(([kind]) => kind !== 'backfill')
        .reduce((sum, [, count]) => sum + count, 0);
      const historySwept = res.sweptByKind?.backfill || 0;
      const historyRequests = res.requestsByKind?.backfill || 0;

      if (mode !== 'backfill') {
        state.searchCoverage = {
          at: now(),
          jobsTotal: liveJobs,
          sweptThisRun: liveSwept,
          requests: liveRequests,
          // Keep live latency separate from the much larger historical backlog.
          fullSweepCycles: Math.max(1, Math.ceil(liveJobs / Math.max(1, liveSwept))),
        };
      }
      if (mode !== 'live') {
        state.backfillCoverage = {
          at: now(),
          jobsTotal: historical.length,
          sweptThisRun: historySwept,
          requests: historyRequests,
        };
      }
      if (days) {
        state.backfill = { at: now(), days, ...backfillProgress(historicalPlan, state.watermarks) };
        log(`  backfill: ${state.backfill.completedWindows}/${state.backfill.totalWindows} school-windows complete`);
      }
      const stale = staleSchools(state);
      if (stale.length) log(`  search: ${stale.length} schools not swept in >2h (oldest ${stale[0].hours}h: ${stale.slice(0, 5).map((s) => s.id).join(', ')})`);
    }
  }

  // --- Lists: corroboration + cheap breadth ------------------------------
  // A List is one request for ~68 posts across ~78 authors, so it is the cheapest
  // possible second opinion on what the sweep found — and it costs no search budget.
  for (const l of mode === 'backfill' ? [] : (lists.lists || [])) {
    if (l.disabled || !l.id) continue;
    const res = await fetchList(l.id);
    if (!res.ok) { log(`  list ${l.name || l.id}: FAILED (${res.error})`); health[`list:${l.id}`] = { at: now(), error: res.error }; continue; }
    const n = push(res.posts, `list:${l.id}`);
    log(`  list ${l.name || l.id}: ${res.posts.length} posts, ${new Set(res.posts.map((p) => p.author)).size} authors, ${n} new, lag ${lagHours(res.posts).toFixed(1)}h`);
  }

  // --- Profiles: rotating backfill --------------------------------------
  // Profile widgets are per-account cached and some are frozen for months, so this is
  // a supplement, never the spine. We measure each one's lag and report the frozen ones
  // so they can be moved into a List instead.
  const wl = readJson('watchlist.json', { handles: {} });
  const promoted = Object.values(wl.handles || {}).filter((h) => h.promoted).map((h) => h.handle);
  const pool = [
    ...SCHOOLS.map((s) => s.handle),
    ...(accounts.reporters || []),
    ...(accounts.aggregators || []),
    ...(accounts.stateScouts?.handles || []),
    ...promoted,
  ];
  const per = mode === 'backfill' ? 0 : Number(process.env.OFFERWIRE_PROFILES_PER_RUN || 25);
  const cur = state.cursors?.profile ?? 0;
  const slice = Array.from({ length: Math.min(per, pool.length) }, (_, i) => pool[(cur + i) % pool.length]);
  (state.cursors ??= {}).profile = (cur + slice.length) % Math.max(1, pool.length);

  let profileNew = 0;
  const frozen = [];
  for (const h of slice) {
    const res = await fetchProfile(h);
    if (!res.ok) { health[`profile:${h}`] = { at: now(), error: res.error }; continue; }
    profileNew += push(res.posts, `profile:${h}`);
    const lag = lagHours(res.posts);
    if (lag > 24 * 14) frozen.push(`${h} (${Math.round(lag / 24)}d)`);
  }
  log(`  profiles: ${slice.length} polled, ${profileNew} new posts`);
  if (frozen.length) log(`  profiles FROZEN (move these into a List): ${frozen.join(', ')}`);
  state.frozenProfiles = frozen;

  // Bound the dedupe set. 60k ids covers many days of wire at real volume.
  state.seenPostIds = [...seen].slice(-60000);
  return fresh;
}

// ---------------------------------------------------------------------------
// 2. PREFILTER  (cheap, deterministic, recall-oriented)
// ---------------------------------------------------------------------------
export function prefilter(posts, log = () => {}, audit = null) {
  const kept = [];
  let hardNeg = 0, noSignal = 0;
  for (const p of posts) {
    // Decoded here as well as at collection, because the archive predates the fix.
    const text = decodeEntities([p.text, p.extra].filter(Boolean).join(' '));
    if (!/offer/i.test(text)) { noSignal++; if (audit) auditReject(audit, 'prefilter', 'no_offer_term', p); continue; }
    const c = classify(text);
    if (c.hardNegative) { hardNeg++; if (audit) auditReject(audit, 'prefilter', 'hard_negative', p); continue; }
    if (!c.kind) { noSignal++; if (audit) auditReject(audit, 'prefilter', 'unclassified_offer_text', p); continue; }
    const schools = findSchools(text + ' ' + (p.mentions || []).map((m) => '@' + m).join(' ') + ' ' + (p.hashtags || []).map((h) => '#' + h).join(' '));
    // The post names a non-FBS institution as the offer source ("offer from Community
    // Christian College"). No cheer in it ("Go cyclones!") may be read as an FBS offer
    // target — that filed a fabricated Iowa State row for a small-college offer.
    if (explicitNonFbsOfferTarget(text)) { hardNeg++; if (audit) auditReject(audit, 'prefilter', 'non_fbs_offer_target', p); continue; }
    // No FBS school anywhere in the post and no ambiguous surface -> it cannot be an
    // FBS offer we can attribute, so it is not worth a token.
    if (!schools.length) { noSignal++; if (audit) auditReject(audit, 'prefilter', 'no_fbs_school', p); continue; }
    kept.push({ ...p, _rules: c, _schools: schools });
  }
  log(`  prefilter: ${posts.length} in -> ${kept.length} candidates (${hardNeg} hard-negative, ${noSignal} no signal)`);
  if (audit) audit.prefilter.accepted = kept.length;
  return kept;
}

/** Football evidence in a self-announcement: a position, football language, a 40 time, or a direct tag of an official FBS football account. */
const footballTokenFor = (p) => {
  const text = `${p.authorBio || ''} ${p.text}`;
  return /\bfootball\b|🏈|\bFB(?:B|U)?\b/i.test(text)
    || /\b([3-5]\.\d{1,2})\s*(?:40\b|40yd\b|forty)\b/i.test(text)
    || /\b40\s*[:=-]?\s*([3-5]\.\d{1,2})\b/i.test(text)
    || (p.mentions || []).some((handle) => SCHOOL_HANDLES.has(String(handle).toLowerCase()));
};

/** Explain a rules-only miss without changing the conservative extraction decision. */
export function rulesOnlyRejectionReason(p) {
  const solid = (p._schools || []).filter((s) => s.id && s.confidence >= 0.9);
  if (solid.length !== 1) return solid.length ? 'multiple_resolved_schools' : 'school_not_resolved_confidently';
  if (p._rules?.kind === 'bare_mention') return 'bare_mention_requires_llm';
  if (p._rules?.kind === 'reporter_voice') {
    const tagged = findTaggedRecruit(p, SCHOOL_HANDLES, KNOWN_ACCOUNTS);
    const name = tagged?.name || findReportedName(p.text) || null;
    if (!name) return 'reporter_missing_player_name';
    if ((findClassYear(p.text) ?? handleClassYear(tagged?.handle)) == null) return 'reporter_missing_class_year';
    if (findPosition(p.text) == null) return 'reporter_missing_position';
    const footballContext = /\bfootball\b|\brecruit(?:ing)?\b|\b(?:QB|RB|WR|TE|OT|OG|OL|IOL|DL|DE|DT|EDGE|LB|ILB|OLB|CB|DB|SAF|ATH)\b/.test(`${p.text} ${p.authorBio || ''}`);
    if (!footballContext) return 'reporter_missing_football_context';
    return 'reporter_unresolved';
  }
  if (p._rules?.kind === 'player_voice') {
    const verdict = looksLikeRecruit(p.authorBio, p.authorName);
    if (!verdict.ok) return `author_not_recruit:${verdict.why}`;
    if (!cleanPersonName(p.authorName)) return 'player_display_name_unusable';
    if ((findClassYear(p.text) ?? verdict.info.classYear ?? handleClassYear(p.author)) == null) return 'player_missing_class_year';
    if ((verdict.info.position ?? findPosition(p.text)) == null && !footballTokenFor(p)) return 'player_missing_football_context';
    return 'player_unresolved';
  }
  return 'unsupported_offer_kind';
}

// ---------------------------------------------------------------------------
// 3. EXTRACT
// ---------------------------------------------------------------------------
// Handles that are never the recruit being offered. Built once: the 136 school accounts
// plus every reporter/aggregator/scout we know by name.
const SCHOOL_HANDLES = new Set(SCHOOLS.map((s) => s.handle.toLowerCase()));
const KNOWN_ACCOUNTS = (() => {
  const a = cfg('accounts.json');
  return new Set([
    ...(a.reporters || []), ...(a.aggregators || []), ...(a.stateScouts?.handles || []),
  ].map((h) => String(h).toLowerCase()));
})();

export function rulesOnlyOffers(p) {
  // Used when the LLM is unavailable. Only fires on the unambiguous shape: exactly one
  // resolvable school and a clear offer voice. Confidence is capped low on purpose.
  const solid = p._schools.filter((s) => s.id && s.confidence >= 0.9);
  if (solid.length !== 1) return [];
  // (bare mentions are handled below, once a tagged recruit can vouch for them)

  const school = solid[0].id;

  // --- reporter voice -----------------------------------------------------
  // Handled deterministically, because X gives us the display name of every tagged
  // account. When the recruit is tagged we read their name straight off the entity;
  // otherwise we fall back to the fixed reporter grammars. Either way, no guessing.
  // A bare mention is normally noise, but "exactly one FBS school AND exactly one tagged
  // account that is neither a school nor a media outlet" is a strong enough combination
  // to trust on its own. That shape is how a lot of real offers read:
  //   "2027 Nat'l No. 24 / 5* Chase Lumpkin @ChaseLumpkin1 (6-4, Powder Springs, GA)
  //    reported an Arkansas offer"
  // Without this they are discarded, and they are exactly the discoveries we want.
  if (p._rules.kind === 'bare_mention') {
    // In rules-only mode a generic use of offer plus one tagged account is not
    // evidence of a recruiting event. Keep these for the archive/LLM, never publish.
    return [];
    const tagged = findTaggedRecruit(p, SCHOOL_HANDLES, KNOWN_ACCOUNTS);
    if (!tagged) return [];

    // A tagged account is NOT enough on its own, and X does not give us the bio of a
    // MENTIONED user (only the author's), so there is no way to verify the tag is a
    // recruit. Without further evidence this path files politics as recruiting:
    //   "Illinois farmers deserve more than reassurances ... the worst of what
    //    democracy has to offer"  -> an Illinois offer to a US Representative.
    //
    // The post carries no offer grammar at all, so the burden of proof falls entirely
    // on the text. Demand BOTH a recruiting class year and a position — the two things
    // every real recruiting post carries and no political or spam post does.
    const cls = findClassYear(p.text);
    const pos = findPosition(p.text);
    if (cls == null || pos == null) return [];

    return [{
      player_name: tagged.name,
      player_handle: tagged.handle,
      school_id: school,
      class_year: cls,
      position: pos,
      high_school: null,
      state: null,
      confidence: 0.45,
    }];
  }

  if (p._rules.kind === 'reporter_voice') {
    const tagged = findTaggedRecruit(p, SCHOOL_HANDLES, KNOWN_ACCOUNTS);
    const prose = findReportedName(p.text);
    const name = tagged?.name || prose || null;
    const handle = tagged?.handle || null;
    const cls = findClassYear(p.text) ?? handleClassYear(tagged?.handle);
    const pos = findPosition(p.text);
    const footballContext = /\bfootball\b|\brecruit(?:ing)?\b|\b(?:QB|RB|WR|TE|OT|OG|OL|IOL|DL|DE|DT|EDGE|LB|ILB|OLB|CB|DB|SAF|ATH)\b/.test(`${p.text} ${p.authorBio || ''}`);
    if (!name || cls == null || pos == null || !footballContext) return [];
    return [{
      player_name: name,
      player_handle: handle,
      school_id: school,
      class_year: cls,
      position: pos,
      high_school: null,
      state: null,
      // A tagged recruit is a much harder fact than a name scraped out of prose.
      confidence: tagged ? 0.6 : 0.5,
    }];
  }

  if (p._rules.kind !== 'player_voice') return [];

  // --- player voice -------------------------------------------------------
  // The author IS the recruit. Their own bio is the only guard against attributing an
  // offer to a coach, an agency, or a basketball player.
  const verdict = looksLikeRecruit(p.authorBio, p.authorName);
  if (!verdict.ok) return [];

  // Recruits overwhelmingly use their real name as their display name, which is the one
  // reliable way to get a NAME out of a self-announcement without an LLM. Require a
  // plausible two-part human name and reject anything with handle-ish decoration.
  const named = cleanPersonName(p.authorName);
  const classYear = findClassYear(p.text) ?? verdict.info.classYear ?? handleClassYear(p.author) ?? null;
  const position = verdict.info.position ?? findPosition(p.text) ?? null;
  // A self-announcement must still show FOOTBALL evidence. A recruit bio that is only
  // height/class/GPA could be a basketball or baseball prospect (dropping the old
  // position gate outright let real basketball recruits — "5'11 G/F", "6'3 CG", "6'8
  // F/C" bios — through). But demanding a position threw away genuine kids whose bio
  // proves football without a position code ("Football/Track Star", "FBU All American",
  // "FB (WR and FS)", or a 40-yard time). So: a football POSITION, or football language
  // (football/FB/FBU/🏈), or a 40 time. Handle-year is the last word on class because a
  // recruit's handle almost always carries it ("coltonfitz2028", "landonghea2029") when
  // their text and bio both omit it.
  if (!named || classYear == null) return [];
  if (!position && !footballTokenFor(p)) return [];

  return [{
    player_name: named,
    player_handle: p.author,
    school_id: school,
    class_year: classYear,
    // Bio position beats text position: the bio is a structured self-declaration,
    // the post text is prose that happens to contain capital letters.
    position,
    high_school: verdict.info.highSchool ?? null,
    state: verdict.info.state ?? null,
    confidence: 0.45,
  }];
}

// ---------------------------------------------------------------------------
// 4. LEDGER
// ---------------------------------------------------------------------------
function offerKey(playerId, schoolId) { return `${playerId}::${schoolId}`; }

/**
 * Is the school nothing but the player's own surname? Live failure: "Dartmouth has
 * offered 2027 SAF Nicholas Washington from River Bluff HS" was published as a
 * Washington offer — Dartmouth is not FBS, so the only school left in the post was the
 * recruit's name. The school counts only if it survives with that name taken out.
 */
function schoolOnlyFromPlayerName(rec, post) {
  const name = String(rec.player_name || '');
  if (!name || !findSchools(name).some((s) => s.id === rec.school_id)) return false;
  const text = decodeEntities([post.text, post.extra].filter(Boolean).join(' '));
  // Remove the player's name where it appears AS A NAME, not every occurrence of its
  // words: "Washington has offered ... Nicholas Washington" is a real Washington offer,
  // and blanking the surname everywhere would throw it away.
  const words = name.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length < 2) return false;
  const stripped = text.replace(new RegExp(`\\b${words.join('\\s+')}\\b`, 'gi'), ' ');
  return !findSchools(stripped).some((s) => s.id === rec.school_id);
}

export function upsert(db, rec, post, verdictConfidence, observedAt = now()) {
  const school = byId.get(rec.school_id);
  if (!school) return null;
  if (schoolOnlyFromPlayerName(rec, post)) return null;

  const incoming = {
    name: rec.player_name,
    bio: post.authorBio && rec.player_handle && post.author === String(rec.player_handle).toLowerCase()
      ? post.authorBio : null,
    handle: rec.player_handle ? String(rec.player_handle).toLowerCase().replace(/^@/, '') : null,
    classYear: rec.class_year ?? null,
    position: rec.position ?? null,
    highSchool: rec.high_school ?? null,
    state: rec.state ?? null,
  };
  // Position is not a blocker here: the extractor has already decided this is a real
  // offer, and a self-announced recruit whose verified bio states measurables but no
  // position is still a real offer row (the first reporter post or the LLM fills the
  // blank; canMerge ignores missing positions entirely). Gating on it there just
  // silently threw away players.
  if (!incoming.name || incoming.classYear == null) return null;
  if (incoming.name && !nameKey(incoming.name)) return null;

  // The recruit's own bio is the richest metadata on the post. Use it only to FILL
  // blanks — anything the extractor read out of the post text itself is better
  // evidence about this specific offer than a static profile line.
  if (incoming.bio) {
    const b = parseBio(incoming.bio);
    for (const f of ['classYear', 'position', 'highSchool', 'state', 'height', 'weight']) {
      if (incoming[f] == null && b[f] != null) incoming[f] = b[f];
    }
    for (const f of ['stars', 'gpa', 'forty']) if (b[f] != null) incoming[f] = b[f];
  }

  // --- player identity ---
  let player = null;
  if (incoming.handle) player = db.players.find((p) => p.handle === incoming.handle) || null;
  if (!player && incoming.name) {
    const r = resolvePlayer(db._index, incoming);
    if (r.ambiguous) db.review.push({ at: observedAt, type: 'ambiguous_player', name: incoming.name, candidates: r.candidates, post: post.id });
    player = r.player;
  }
  if (!player) {
    // A handle with no name is still a real player — it is exactly what a self-announced
    // offer looks like ("Blessed to receive an offer from @X" posted by the kid). Key the
    // record on the handle and let mergeInto backfill the name when a reporter post
    // supplies it. Dropping these would empty the wire of precisely the discoveries this
    // system exists to make.
    const identity = incoming.name || '@' + incoming.handle;
    player = {
      id: 'p_' + sha1(identity + '|' + (incoming.classYear ?? '') + '|' + (incoming.handle ?? '')),
      ...incoming,
      aliases: incoming.name ? [incoming.name] : [],
      firstSeen: observedAt,
    };
    db.players.push(player);
    if (incoming.name) db._new.push(player);
    // Index it immediately, not just at the end of the run's loop. Two posts about the
    // same brand-new recruit arriving in the same run (e.g. his own announcement plus a
    // reporter's corroboration) must merge into one record — leaving the index stale
    // until after the loop meant the second post's lookup never saw the first post's
    // insert and created a duplicate player instead. Real live failure: two "Chase
    // Lumpkin" records, one from each voice, never merged despite matching class year.
    const fk = fuzzyKey(player.name);
    if (fk) {
      if (!db._index.has(fk)) db._index.set(fk, []);
      db._index.get(fk).push(player);
    }
  } else {
    mergeInto(player, incoming);
  }

  // --- offer edge ---
  const key = offerKey(player.id, school.id);
  let offer = db.offerMap.get(key);
  const evidence = {
    postId: post.id,
    author: post.author,
    url: post.url || `https://x.com/${post.author}/status/${post.id}`,
    postedAt: post.createdAt,
    via: post.via || null,
    confidence: verdictConfidence,
    text: post.text.slice(0, 400),
    attribution: rec.attribution || null,
  };

  if (!offer) {
    offer = {
      id: 'o_' + sha1(key),
      playerId: player.id,
      playerName: player.name,
      schoolId: school.id,
      schoolName: school.name,
      conference: school.conference,
      // The offer date is the EARLIEST post we have reporting it, not the newest —
      // a reporter recapping three days later must not reset the clock.
      offeredAt: post.createdAt,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      confidence: verdictConfidence,
      corroborations: 1,
      evidence: [evidence],
      status: 'new',
    };
    db.offers.push(offer);
    db.offerMap.set(key, offer);
    db.newOffers.push(offer);
  } else {
    if (offer.evidence.some((e) => e.postId === post.id)) return offer;
    offer.evidence.push(evidence);
    offer.evidence.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
    offer.offeredAt = offer.evidence[0].postedAt;
    offer.lastSeenAt = observedAt;
    offer.corroborations = new Set(offer.evidence.map((e) => e.author)).size;
    // Independent corroboration raises confidence toward — never to — certainty.
    offer.confidence = Math.min(0.99, Math.max(offer.confidence, verdictConfidence) + 0.08 * (offer.corroborations - 1));
    offer.status = offer.corroborations > 1 ? 'corroborated' : offer.status;
  }
  offer.playerName ||= player.name;
  return offer;
}


// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  const audit = {
    at: now(),
    mode: String(process.env.OFFERWIRE_MODE || 'live').toLowerCase(),
    collection: { returned: 0, kept: 0, duplicate: 0, tooOld: 0, future: 0, invalid: 0 },
    prefilter: { accepted: 0, rejected: 0, reasons: {}, samples: [] },
    extraction: { accepted: 0, rejected: 0, reasons: {}, samples: [] },
  };


  log(`OfferWire run @ ${now()}`);
  const state = readJson('state.json', { seenPostIds: [], cursors: {}, health: {} });
  // v3 is a one-time deployment migration: discard historical/truncated cursors and
  // start every live query at deployment with a small overlap. It never re-runs.
  if (state.migrationVersion !== 3) {
    const deployment = new Date(Date.now() - 5 * 60e3).toISOString();
    state.watermarks ||= {};
    for (const job of allJobs()) state.watermarks[job.key] = { at: deployment, migratedAt: now(), lastPosts: 0, truncated: false };
    for (const key of Object.keys(state.watermarks)) if (key.startsWith('backfill:')) delete state.watermarks[key];
    state.backfill = null; state.backfillCoverage = null; delete state.backfillAnchorAt;
    state.migrationVersion = 3; state.liveDeploymentAt = deployment;
  }
  state.firstRunAt ||= now();

  const accounts = cfg('accounts.json');
  watch.seedKnown([
    ...(accounts.reporters || []),
    ...(accounts.aggregators || []),
    ...(accounts.stateScouts?.handles || []),
  ]);

  // 1 — collect
  log('collect:');
  const fresh = await collect(state, log, audit);
  log(`  total new posts: ${fresh.length}`);
  appendNdjson(`raw/${new Date().toISOString().slice(0, 10)}.ndjson`, fresh);

  // 2 — prefilter
  log('extract:');
  const candidates = prefilter(fresh, log, audit);

  // 3 ? deterministic extraction only; production has no paid-LLM dependency.
  const verdicts = new Map();
  log('  extraction: deterministic rules + target attribution');

  // 4 ? ledger
  const players = readJson('players.json', []);
  const offers = readJson('offers.json', []);
  const wl = readJson('watchlist.json', { handles: {} });
  const affiliations = readJson('affiliations.json', { version: 1, accounts: {} });
  const pending = readJson('pending.json', { version: 1, candidates: {} });
  const decisions = new Map(fresh.map((p) => [p.id, { postId: p.id, at: now(), status: 'irrelevant', reason: 'prefilter_not_candidate' }]));
  for (const p of candidates) seedDisplayAffiliations(p, affiliations);
  const db = {
    players, offers, review: [],
    offerMap: new Map(offers.map((o) => [offerKey(o.playerId, o.schoolId), o])),
    _index: indexPlayers(players),
    _new: [], newOffers: [],
  };

  let accepted = 0, rejected = 0;
  for (const p of candidates) {
    const v = verdicts.get(p.id);
    let recs = rulesOnlyOffers(p);
    const conf = 0.45;
    if (!recs.length) {
      rejected++;
      const reason = rulesOnlyRejectionReason(p);
      auditReject(audit, 'extraction', reason, p);
      decisions.set(p.id, { postId: p.id, at: now(), status: 'rejected', reason });
    }
    const made = [];
    for (const rec of recs) {
      const target = resolveOfferTarget(p, affiliations);
      if (target.status !== 'accepted') {
        const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString();
        if (target.status === 'pending') pending.candidates[p.id] = { postId: p.id, postPath: `raw/${new Date(p.createdAt).toISOString().slice(0, 10)}.ndjson`, createdAt: p.createdAt, updatedAt: now(), expiresAt, reason: target.reason, evidence: target.evidence };
        decisions.set(p.id, { postId: p.id, at: now(), status: target.status, reason: target.reason, evidence: target.evidence });
        rejected++; auditReject(audit, 'extraction', target.reason, p); continue;
      }
      rec.school_id = target.schoolId; rec.attribution = target.evidence;
      const c = conf ?? Math.min(0.98, (rec.confidence ?? 0.6) * (p._rules.prior > 0 ? 1 : 0.8));
      if (c < 0.4) { rejected++; auditReject(audit, 'extraction', 'confidence_below_threshold', p); continue; }
      const o = upsert(db, rec, p, c);
      if (o) {
        accepted++; audit.extraction.accepted++; made.push(rec);
        decisions.set(p.id, { postId: p.id, at: now(), status: 'accepted', reason: target.reason, evidence: target.evidence });
      } else {
        rejected++; auditReject(audit, 'extraction', 'invalid_or_incomplete_offer_record', p);
      }
    }
    if (made.length) watch.observe(wl, p, made);
  }

  // Safety net: upsert() now indexes each new player as it's created (the actual fix —
  // see the comment there), so this should be a no-op. Kept because a full rebuild from
  // db.players is the one thing that can never drift from the source of truth.
  db._index = indexPlayers(db.players);

  // Tier + evidence-backed per-player totals run on the full ledger.
  const playerStats = decorateOffers(db.offers);
  for (const p of db.players) {
    const st = playerStats.get(p.id);
    if (st) p.offerCounts = { total: st.total, p4: st.p4, g5: st.g5 };
  }
  log(`  tiers: ${playerStats.size} players tracked`);

  const newlyPromoted = watch.promote(wl);
  const pruned = watch.prune(wl);
  audit.outcome = { acceptedEvidence: accepted, rejectedCandidates: rejected, brandNewOffers: db.newOffers.length };
  state.lastAudit = audit;
  state.lastDecisionCoverage = { total: fresh.length, decided: decisions.size, complete: decisions.size === fresh.length };
  appendNdjson(`audit/${new Date().toISOString().slice(0, 10)}.ndjson`, [audit]);
  // One compact record per future unique post; no tweet text is duplicated here.
  appendNdjson(`decisions/${new Date().toISOString().slice(0, 10)}.ndjson`, [...decisions.values()]);
  for (const [id, item] of Object.entries(pending.candidates)) if (new Date(item.expiresAt).getTime() <= Date.now()) delete pending.candidates[id];

  log(`  offers: ${accepted} accepted, ${rejected} rejected, ${db.newOffers.length} brand new`);
  log(`  watchlist: ${Object.keys(wl.handles).length} handles (${newlyPromoted.length} promoted, ${pruned} pruned)`);

  // 5 — publish
  db.offers.sort((a, b) => new Date(b.offeredAt) - new Date(a.offeredAt));
  writeJson('offers.json', db.offers);
  writeJson('players.json', db.players);
  writeJson('watchlist.json', wl);
  writeJson('affiliations.json', affiliations);
  writeJson('pending.json', pending);
  if (db.review.length) appendNdjson('review.ndjson', db.review);

  // The site reads only these two, so they stay small and cheap to serve.
  const playerById = new Map(db.players.map((p) => [p.id, p]));
  const recent = db.offers.slice(0, 1500).map((offer) => {
    const player = playerById.get(offer.playerId) || {};
    return {
      ...offer,
      playerName: player.name || offer.playerName,
      playerHandle: player.handle || null,
      classYear: player.classYear ?? null,
      position: player.position ?? null,
      highSchool: player.highSchool ?? null,
      state: player.state ?? null,
    };
  });
  writeJson('site/wire.json', {
    generatedAt: now(),
    counts: {
      offers: db.offers.length,
      players: db.players.length,
      newThisRun: db.newOffers.length,
      watchlist: Object.keys(wl.handles).length,
    },
    offers: recent,
  });
  writeJson('site/status.json', {
    generatedAt: now(),
    runMs: Date.now() - t0,
    searchCredentials: loadCredentials().length,
    searchConfigured: state.searchConfigured !== false,
    // False until the wire has had long enough for one full sweep cycle, so the
    // coverage gate does not fire on a ledger that is simply new.
    warmedUp: !!(state.firstRunAt && Date.now() - new Date(state.firstRunAt).getTime() > 3 * 3600e3),
    searchCoverage: state.searchCoverage || null,
    backfillCoverage: state.backfillCoverage || null,
    backfill: state.backfill || null,
    staleSchools: staleSchools(state),
    liveStaleness: liveStaleness(state),
    quality: {
      // Position is deliberately not part of the completeness bar — real self-announced
      // offers publish with a null position (bio proves football, position backfilled
      // later). build-status.mjs holds the same definition.
      completeOffers: recent.filter((o) => o.playerName && o.classYear).length,
      incompleteOffers: recent.filter((o) => !o.playerName || !o.classYear).length,
    },
    audit,
    llm: null,
    decisionCoverage: { total: fresh.length, decided: decisions.size, complete: decisions.size === fresh.length },
    pending: { total: Object.keys(pending.candidates).length },
    profileResolution: { cached: Object.keys(affiliations.accounts || {}).length },
    paginationBacklog: Object.values(state.watermarks || {}).filter((m) => m.window).length,
    frozenProfiles: state.frozenProfiles || [],
    health: state.health,
    log: lines,
  });

  writeJson('state.json', state);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // The ledger is written first so a search outage still preserves whatever the list
  // readers found — but the run itself fails, because a wire without search is not a
  // wire and must not look like a green build.
  if (state.searchConfigured === false) {
    console.error('\nFAILING RUN: search is the engine of this system and it is not working.');
    process.exit(2);
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}

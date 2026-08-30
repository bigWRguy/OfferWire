// The self-expanding watchlist.
//
// Search finds offers from accounts we have never heard of. That is only half the
// value — the other half is REMEMBERING those accounts, because a kid who just took
// his first offer is about to take his second, third and tenth, and from then on we
// want him covered by the cheap always-on readers rather than by a lucky search hit.
//
// So every confirmed offer post feeds the mention graph:
//   - the author, if the author was the recruit
//   - any mentioned handle the LLM identified as the recruit
//   - any mentioned handle that is not a known school, reporter or aggregator
//
// Candidates accumulate evidence over time and get promoted once they clear a bar.
// Promoted handles are what scripts/plan-lists.mjs tells you to put in your X Lists.
import { HANDLES } from './resolve/schools.js';

const KNOWN_NON_PLAYER = new Set();
export function seedKnown(handles) {
  for (const h of handles) KNOWN_NON_PLAYER.add(String(h).toLowerCase());
}

// Handles that are obviously institutional rather than a recruit.
const INSTITUTIONAL = /(football|athletics|recruit|sports|coach|hs|highschool|academy|prep|nation|report|media|network|scout|rivals|247|on3|espn|team|official)/i;

/**
 * @param {object} wl        data/watchlist.json  { handles: {h: {...}} }
 * @param {object} post      the source post
 * @param {object[]} offers  extracted offer entries for that post
 */
export function observe(wl, post, offers, observedAt = new Date().toISOString()) {
  wl.handles ??= {};
  const now = observedAt;

  const add = (handle, reason, weight) => {
    const h = String(handle || '').toLowerCase().replace(/^@/, '');
    if (!h || h.length < 2) return;
    if (HANDLES.has(h)) return;              // it's a school
    if (KNOWN_NON_PLAYER.has(h)) return;     // it's a reporter/aggregator we already poll
    const e = (wl.handles[h] ??= {
      handle: h, score: 0, firstSeen: now, lastSeen: now,
      offers: 0, reasons: [], name: null, classYear: null, position: null, promoted: false,
    });
    e.lastSeen = now;
    e.score += weight;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    return e;
  };

  for (const o of offers) {
    // Strongest signal: the model named this handle as the recruit.
    if (o.player_handle) {
      const e = add(o.player_handle, 'identified_recruit', 3);
      if (e) {
        e.offers += 1;
        e.name ??= o.player_name;
        e.classYear ??= o.class_year;
        e.position ??= o.position;
      }
    }
    // The author announced their own offer.
    if (post.author && o.player_handle && post.author === o.player_handle.toLowerCase()) {
      add(post.author, 'self_announced', 2);
    }
  }

  // Weak signal: any other human-looking handle mentioned in a confirmed offer post.
  // Low weight on purpose — this is where teammates, parents and 7-on-7 coaches enter,
  // and they should need repeated appearances before they earn a poll slot.
  if (offers.length) {
    for (const m of post.mentions || []) {
      if (INSTITUTIONAL.test(m)) continue;
      add(m, 'mentioned_in_offer', 0.5);
    }
  }
  return wl;
}

/** Promote candidates that have earned a slot; returns the newly promoted handles. */
export function promote(wl, { minScore = 3, minOffers = 1, observedAt = new Date().toISOString() } = {}) {
  const newly = [];
  for (const e of Object.values(wl.handles || {})) {
    if (e.promoted) continue;
    if (e.score >= minScore || e.offers >= minOffers) {
      e.promoted = true;
      e.promotedAt = observedAt;
      newly.push(e.handle);
    }
  }
  return newly;
}

/** Drop stale candidates that never earned promotion, so the file doesn't grow forever. */
export function prune(wl, { maxAgeDays = 120 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 864e5;
  let removed = 0;
  for (const [h, e] of Object.entries(wl.handles || {})) {
    if (e.promoted) continue;
    if (new Date(e.lastSeen).getTime() < cutoff && e.score < 2) { delete wl.handles[h]; removed++; }
  }
  return removed;
}

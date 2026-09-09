import { HANDLES } from './resolve/schools.js';

const KNOWN_NON_PLAYER = new Set();
export function seedKnown(handles) {
  for (const h of handles) KNOWN_NON_PLAYER.add(String(h).toLowerCase());
}

const INSTITUTIONAL = /(football|athletics|recruit|sports|coach|hs|highschool|academy|prep|nation|report|media|network|scout|rivals|247|on3|espn|team|official)/i;

export function observe(wl, post, offers, observedAt = new Date().toISOString()) {
  wl.handles ??= {};
  const now = observedAt;

  const add = (handle, reason, weight) => {
    const h = String(handle || '').toLowerCase().replace(/^@/, '');
    if (!h || h.length < 2) return;
    if (HANDLES.has(h)) return;
    if (KNOWN_NON_PLAYER.has(h)) return;
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
    if (o.player_handle) {
      const e = add(o.player_handle, 'identified_recruit', 3);
      if (e) {
        e.offers += 1;
        e.name ??= o.player_name;
        e.classYear ??= o.class_year;
        e.position ??= o.position;
      }
    }
    if (post.author && o.player_handle && post.author === o.player_handle.toLowerCase()) {
      add(post.author, 'self_announced', 2);
    }
  }

  if (offers.length) {
    for (const m of post.mentions || []) {
      if (INSTITUTIONAL.test(m)) continue;
      add(m, 'mentioned_in_offer', 0.5);
    }
  }
  return wl;
}

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

export function prune(wl, { maxAgeDays = 120 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 864e5;
  let removed = 0;
  for (const [h, e] of Object.entries(wl.handles || {})) {
    if (e.promoted) continue;
    if (new Date(e.lastSeen).getTime() < cutoff && e.score < 2) { delete wl.handles[h]; removed++; }
  }
  return removed;
}

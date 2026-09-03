// ============================================================================
// X reader — the SECONDARY sources. `src/collect/search.js` (browser-driven per-school
// search) is the engine and primary source; this file predates that pivot and is now a
// supplement, not a replacement for it. Both readers stay in use:
//
//   * cdn.syndication.twimg.com (the backend X serves to embedded widgets) is open,
//     unauthenticated, and returns real post JSON. Two routes work:
//
//       srv/timeline-profile/screen-name/<handle>   ~20 posts, ONE author
//       srv/timeline-list/list-id/<id>              ~68 posts, up to ~78 authors
//
//   * A List is nearly free (no search budget spent) and gives cheap corroboration of
//     what the search sweep already found, across ~78 authors in one request.
//   * The profile route is per-account cached and the cache is NOT bustable. Measured:
//     @TexasFootball fresh to the minute, @OhioStateFB 11 days stale,
//     @Hayesfawcett3 TEN MONTHS stale (frozen at 2025-10-26) — identical for
//     ?showReplies, ?lang, cache-buster params and no-cache headers. Profiles are
//     opportunistic backfill only, scored on measured freshness lag so a frozen widget
//     is never mistaken for a quiet account (see `frozenProfiles` in pipeline.js).
// ============================================================================
import { get } from '../lib/http.js';
import { decodeEntities } from '../lib/store.js';

const HOSTS = [
  'https://cdn.syndication.twimg.com',
  'https://syndication.twimg.com', // historical alias; kept as failover
];

/**
 * Walk the widget's __NEXT_DATA__ blob and harvest anything shaped like a post.
 * Deliberately structure-agnostic: X reshapes this payload without notice, and a
 * recursive harvest survives renames that a path-based parser would not. It also
 * picks up quoted and retweeted posts for free, which is real extra reach — a
 * reporter quote-tweeting a player's announcement gives us the player's own words.
 */
function harvest(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) harvest(n, out, seen); return out; }

  const id = node.id_str || node.rest_id;
  // X serves this HTML-escaped; every downstream rule reads plain text.
  const text = decodeEntities(node.full_text ?? node.text);
  const created = node.created_at;
  if (id && typeof text === 'string' && created && !seen.has(id)) {
    seen.add(id);
    const u = node.user || node.core?.user_results?.result?.legacy || {};
    const ent = node.entities || {};
    const t = new Date(created);
    if (!Number.isNaN(t.getTime())) {
      out.push({
        id,
        text,
        author: String(u.screen_name || u.username || '').toLowerCase(),
        authorName: u.name || '',
        authorFollowers: u.followers_count ?? null,
        authorVerified: !!(u.verified || u.is_blue_verified),
        createdAt: t.toISOString(),
        // Entity lists are far more reliable than regexing the text, especially for
        // mentions, which is how the watchlist grows.
        mentions: (ent.user_mentions || []).map((m) => String(m.screen_name || '').toLowerCase()).filter(Boolean),
        hashtags: (ent.hashtags || []).map((h) => String(h.text || '')).filter(Boolean),
        links: (ent.urls || []).map((u2) => u2.expanded_url).filter(Boolean),
        hasMedia: !!(ent.media?.length || node.extended_entities?.media?.length),
        isRetweet: /^RT @/.test(text),
        source: 'x',
      });
    }
  }
  for (const v of Object.values(node)) harvest(v, out, seen);
  return out;
}

function parseWidget(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function fetchWidget(pathname) {
  let lastErr = 'unknown';
  for (const host of HOSTS) {
    const r = await get(host + pathname, {
      minGapMs: 1100,          // syndication 429s hard on bursts; measured.
      timeoutMs: 25000,
      tries: 2,
      accept: 'text/html,*/*',
    });
    if (!r.ok) { lastErr = r.error || `HTTP ${r.status}`; continue; }
    const json = parseWidget(r.text);
    if (!json) { lastErr = 'no __NEXT_DATA__'; continue; }
    const posts = harvest(json);
    if (!posts.length) { lastErr = 'zero posts'; continue; }
    return { ok: true, posts, host };
  }
  return { ok: false, posts: [], error: lastErr };
}

/** One X List -> up to ~68 posts across up to ~78 authors, live. The workhorse. */
export async function fetchList(listId) {
  const res = await fetchWidget(`/srv/timeline-list/list-id/${encodeURIComponent(listId)}`);
  return { ...res, kind: 'list', listId, posts: res.posts.map((p) => ({ ...p, via: `list:${listId}` })) };
}

/** One profile -> ~20 posts, one author, freshness NOT guaranteed. Backfill only. */
export async function fetchProfile(handle) {
  const res = await fetchWidget(`/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`);
  const h = handle.toLowerCase();
  // The widget bundles quoted posts from other authors; for a profile pull we only
  // trust the posts actually authored by the handle we asked for, plus retweets it
  // carried (those still tell us what this account amplified).
  const posts = res.posts
    .map((p) => ({ ...p, author: p.author || h, via: `profile:${h}` }))
    .filter((p) => p.author === h || p.isRetweet);
  return { ...res, kind: 'profile', handle: h, posts };
}

/**
 * Measured freshness of a source, in hours. This is the number that tells us whether
 * a quiet account is quiet or frozen. Anything above ~48h on an account that posts
 * daily means the widget cache is stale and the account must be moved into a List.
 */
export function lagHours(posts, now = Date.now()) {
  if (!posts.length) return Infinity;
  const newest = Math.max(...posts.map((p) => new Date(p.createdAt).getTime()));
  return (now - newest) / 36e5;
}

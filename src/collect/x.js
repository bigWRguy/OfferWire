import { get } from '../lib/http.js';
import { decodeEntities } from '../lib/store.js';

const HOSTS = [
  'https://cdn.syndication.twimg.com',
  'https://syndication.twimg.com',
];

function harvest(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) harvest(n, out, seen); return out; }

  const id = node.id_str || node.rest_id;
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
      minGapMs: 1100,
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

export async function fetchList(listId) {
  const res = await fetchWidget(`/srv/timeline-list/list-id/${encodeURIComponent(listId)}`);
  return { ...res, kind: 'list', listId, posts: res.posts.map((p) => ({ ...p, via: `list:${listId}` })) };
}

export async function fetchProfile(handle) {
  const res = await fetchWidget(`/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`);
  const h = handle.toLowerCase();
  const posts = res.posts
    .map((p) => ({ ...p, author: p.author || h, via: `profile:${h}` }))
    .filter((p) => p.author === h || p.isRetweet);
  return { ...res, kind: 'profile', handle: h, posts };
}

export function lagHours(posts, now = Date.now()) {
  if (!posts.length) return Infinity;
  const newest = Math.max(...posts.map((p) => new Date(p.createdAt).getTime()));
  return (now - newest) / 36e5;
}

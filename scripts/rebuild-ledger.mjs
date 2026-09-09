import fs from 'node:fs';
import path from 'node:path';
import { prefilter, rulesOnlyOffers, upsert } from '../src/pipeline.js';
import { indexPlayers } from '../src/resolve/players.js';
import { decorateOffers } from '../src/resolve/tiers.js';
import { resolveOfferTarget, seedDisplayAffiliations } from '../src/resolve/attribution.js';
import { readJson, writeJson, DATA } from '../src/lib/store.js';
import * as watch from '../src/watchlist.js';

const write = process.argv.includes('--write');

const accounts = JSON.parse(fs.readFileSync(path.join(path.dirname(DATA), 'config', 'accounts.json'), 'utf8'));
watch.seedKnown([
  ...(accounts.reporters || []),
  ...(accounts.aggregators || []),
  ...(accounts.stateScouts?.handles || []),
]);

const rawDir = path.join(DATA, 'raw');
const posts = fs.readdirSync(rawDir).sort().flatMap((f) =>
  fs.readFileSync(path.join(rawDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
console.log(`replaying ${posts.length} archived posts through the current pipeline...`);

const replayMs = Math.max(...posts.map((p) => new Date(p.createdAt).getTime()).filter(Number.isFinite));
const replayAt = Number.isFinite(replayMs) ? new Date(replayMs).toISOString() : '1970-01-01T00:00:00.000Z';

const candidates = prefilter(posts);

const db = {
  players: [], offers: [], review: [],
  offerMap: new Map(),
  _index: indexPlayers([]),
  _new: [], newOffers: [],
};
const wl = { handles: {} };
const affiliations = { version: 1, accounts: {} };

let accepted = 0, rejected = 0;
for (const p of candidates) {
  seedDisplayAffiliations(p, affiliations, replayAt);
  const recs = rulesOnlyOffers(p);
  const made = [];
  for (const rec of recs) {
    const target = resolveOfferTarget(p, affiliations);
    if (target.status !== 'accepted') { rejected++; continue; }
    rec.school_id = target.schoolId; rec.attribution = target.evidence;
    const c = Math.min(0.98, (rec.confidence ?? 0.6) * (p._rules.prior > 0 ? 1 : 0.8));
    if (c < 0.4) { rejected++; continue; }
    const o = upsert(db, rec, p, c, replayAt);
    if (o) { accepted++; made.push(rec); }
  }
  if (made.length) watch.observe(wl, p, made, replayAt);
}
watch.promote(wl, { observedAt: replayAt });

const playerStats = decorateOffers(db.offers);
for (const p of db.players) {
  const st = playerStats.get(p.id);
  if (st) p.offerCounts = { total: st.total, p4: st.p4, g5: st.g5 };
}

const before = {
  players: readJson('players.json', []).length,
  offers: readJson('offers.json', []).length,
  watchlist: Object.keys(readJson('watchlist.json', { handles: {} }).handles || {}).length,
};

console.log('\nbefore -> after (this replay):');
console.log(`  players   : ${before.players} -> ${db.players.length}`);
console.log(`  offers    : ${before.offers} -> ${db.offers.length}`);
console.log(`  watchlist : ${before.watchlist} -> ${Object.keys(wl.handles).length}`);
console.log(`  accepted ${accepted}, rejected ${rejected}`);

console.log('\nplayers in the rebuilt ledger:');
for (const p of db.players) console.log(`  ${p.name ?? '(unnamed)'} | @${p.handle ?? ''}`);

if (write) {
  db.offers.sort((a, b) => new Date(b.offeredAt) - new Date(a.offeredAt));
  writeJson('players.json', db.players);
  writeJson('offers.json', db.offers);
  writeJson('watchlist.json', wl);
  writeJson('affiliations.json', affiliations);
  writeJson('pending.json', { version: 1, candidates: {} });
  const players = db.players;
  const offers = db.offers;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const published = offers.slice(0, 1500).map((offer) => {
    const player = playerById.get(offer.playerId) || {};
    return { ...offer, playerName: player.name || offer.playerName, playerHandle: player.handle || null,
      classYear: player.classYear ?? null, position: player.position ?? null,
      highSchool: player.highSchool ?? null, state: player.state ?? null };
  });
  writeJson('site/wire.json', {
    generatedAt: replayAt,
    counts: { offers: offers.length, players: players.length, newThisRun: 0, watchlist: Object.keys(wl.handles).length },
    offers: published,
  });
  console.log('\nwritten: data/players.json, data/offers.json, data/watchlist.json, data/site/wire.json');
} else {
  console.log('\nDry run only. Re-run with --write to apply.');
}

// Rebuilds data/players.json, data/offers.json, and data/watchlist.json FROM SCRATCH by
// replaying data/raw/*.ndjson through the current (fixed) pipeline.
//
// Why this exists: the ledger currently committed was written by the wire's very first
// run, before the precision fixes in src/pipeline.js, src/extract/rules.js, and
// src/resolve/schools.js existed. That run's rules-only extraction had the bugs
// documented in HANDOFF.md Blocker 1, and the ledger still carries their output —
// real non-recruit accounts (a US Representative, a WikiLeaks account, "Emergency
// Broadcast System") sitting in data/players.json and, worse, in the PROMOTED
// watchlist, which scripts/plan-lists.mjs would otherwise tell you to paste into a
// permanent X List. Patching individual bad rows by hand cannot be trusted to find
// everything a bug like that produced; replaying the whole archive through the fixed
// code can.
//
// This does NOT touch data/raw/*.ndjson (the archive is the append-only source of
// truth) or data/state.json (search watermarks are unrelated to ledger content).
//
//   node scripts/rebuild-ledger.mjs            # dry run, prints before/after counts
//   node scripts/rebuild-ledger.mjs --write    # applies it and rewrites data/*.json
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

// Replays must be byte-for-byte reproducible. Use the newest evidence timestamp as
// the observation clock instead of wall time, which otherwise churns every ledger row.
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

// Same tier + per-player offer stats as the live pipeline, so a rebuilt ledger is
// byte-identical to what the wire would have written.
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

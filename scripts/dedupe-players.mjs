import { readJson, writeJson } from '../src/lib/store.js';
import { indexPlayers, canMerge, mergeInto } from '../src/resolve/players.js';

const write = process.argv.includes('--write');

const players = readJson('players.json', []);
const offers = readJson('offers.json', []);

const index = indexPlayers(players);
const toDrop = new Set();
const remap = new Map();
const merges = [];

for (const bucket of index.values()) {
  if (bucket.length < 2) continue;
  for (let i = 0; i < bucket.length; i++) {
    const a = bucket[i];
    if (toDrop.has(a.id)) continue;
    for (let j = i + 1; j < bucket.length; j++) {
      const b = bucket[j];
      if (toDrop.has(b.id)) continue;
      const v = canMerge(a, b);
      if (!v.merge) continue;
      const [winner, loser] = a.handle || !b.handle ? [a, b] : [b, a];
      mergeInto(winner, loser);
      toDrop.add(loser.id);
      remap.set(loser.id, winner.id);
      merges.push({ kept: winner.id, dropped: loser.id, name: winner.name, why: v.why });
    }
  }
}

console.log(`found ${merges.length} duplicate pair(s):`);
for (const m of merges) console.log(`  merge ${m.dropped} -> ${m.kept}  (${m.name}, matched on ${m.why})`);

if (!merges.length) {
  console.log('nothing to do.');
  process.exit(0);
}

const survivingPlayers = players.filter((p) => !toDrop.has(p.id));

const bySchoolPlayer = new Map();
const survivingOffers = [];
for (const o of offers) {
  const playerId = remap.get(o.playerId) || o.playerId;
  const key = `${playerId}::${o.schoolId}`;
  const existing = bySchoolPlayer.get(key);
  if (!existing) {
    const merged = { ...o, playerId };
    bySchoolPlayer.set(key, merged);
    survivingOffers.push(merged);
  } else {
    for (const e of o.evidence) if (!existing.evidence.some((x) => x.postId === e.postId)) existing.evidence.push(e);
    existing.evidence.sort((x, y) => new Date(x.postedAt) - new Date(y.postedAt));
    existing.offeredAt = existing.evidence[0].postedAt;
    existing.corroborations = new Set(existing.evidence.map((e) => e.author)).size;
    existing.confidence = Math.max(existing.confidence, o.confidence);
  }
}

console.log(`players: ${players.length} -> ${survivingPlayers.length}`);
console.log(`offers:  ${offers.length} -> ${survivingOffers.length}`);

if (write) {
  writeJson('players.json', survivingPlayers);
  writeJson('offers.json', survivingOffers);
  console.log('written.');
} else {
  console.log('\nDry run only. Re-run with --write to apply.');
}

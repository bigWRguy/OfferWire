import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const from = path.join(ROOT, 'data', 'site');
const to = path.join(ROOT, 'site');
fs.mkdirSync(to, { recursive: true });
let n = 0;
for (const f of fs.existsSync(from) ? fs.readdirSync(from) : []) {
  fs.copyFileSync(path.join(from, f), path.join(to, f));
  n++;
}
if (!n) {
  fs.writeFileSync(path.join(to, 'wire.json'), JSON.stringify({ generatedAt: null, counts: {}, offers: [] }));
  fs.writeFileSync(path.join(to, 'status.json'), JSON.stringify({ generatedAt: null, log: ['wire has not run yet'] }));
}
try {
  const wirePath = path.join(to, 'wire.json');
  const playersPath = path.join(ROOT, 'data', 'players.json');
  const offersPath = path.join(ROOT, 'data', 'offers.json');
  if (fs.existsSync(wirePath) && fs.existsSync(playersPath)) {
    const wire = JSON.parse(fs.readFileSync(wirePath, 'utf-8'));
    const players = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
    const offersByPlayer = new Map();
    if (fs.existsSync(offersPath)) {
      const offers = JSON.parse(fs.readFileSync(offersPath, 'utf-8'));
      for (const o of offers) {
        if (!offersByPlayer.has(o.playerId)) offersByPlayer.set(o.playerId, []);
        offersByPlayer.get(o.playerId).push({
          schoolName: o.schoolName,
          tier: o.tier ?? null,
          offeredAt: o.offeredAt,
        });
      }
      for (const list of offersByPlayer.values()) list.sort((a, b) => new Date(b.offeredAt) - new Date(a.offeredAt));
    }
    const bioMap = new Map();
    for (const p of players) {
      bioMap.set(p.id, {
        height: p.height ?? null,
        weight: p.weight ?? null,
        gpa: p.gpa ?? null,
        bio: p.bio ?? null,
        state: p.state ?? null,
        offerCounts: p.offerCounts ?? null,
        offers: (offersByPlayer.get(p.id) || []).slice(0, 30),
      });
    }
    if (wire.offers) {
      for (const o of wire.offers) {
        o.player = bioMap.get(o.playerId) || null;
        if (!o.state && o.player?.state) o.state = o.player.state;
      }
    }
    fs.writeFileSync(wirePath, JSON.stringify(wire));
    n++;
  }
} catch (e) {
  console.error('build-site: failed to enrich wire.json:', e.message);
}
console.log(`build-site: ${n} file(s)`);

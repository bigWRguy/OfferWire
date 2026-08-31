// Copies the wire's published JSON next to the static site. Netlify runs this; it is
// deliberately the entire build step.
// Also enriches wire.json with player bio data from players.json.
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
  // First deploy, before the wire has ever run. Emit an empty wire so the page renders
  // instead of 404ing on fetch.
  fs.writeFileSync(path.join(to, 'wire.json'), JSON.stringify({ generatedAt: null, counts: {}, offers: [] }));
  fs.writeFileSync(path.join(to, 'status.json'), JSON.stringify({ generatedAt: null, log: ['wire has not run yet'] }));
}
// Enrich wire.json with player bios, P4/G5 offer counts and each player's offer list.
try {
  const wirePath = path.join(to, 'wire.json');
  const playersPath = path.join(ROOT, 'data', 'players.json');
  const offersPath = path.join(ROOT, 'data', 'offers.json');
  if (fs.existsSync(wirePath) && fs.existsSync(playersPath)) {
    const wire = JSON.parse(fs.readFileSync(wirePath, 'utf-8'));
    const players = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
    // Full per-player offer lists come from the WHOLE ledger, not the newest 1500
    // slice the site ships, so counts and lists stay complete for every player.
    const offersByPlayer = new Map();
    if (fs.existsSync(offersPath)) {
      const offers = JSON.parse(fs.readFileSync(offersPath, 'utf-8'));
      for (const o of offers) {
        if (!offersByPlayer.has(o.playerId)) offersByPlayer.set(o.playerId, []);
        offersByPlayer.get(o.playerId).push({
          schoolName: o.schoolName,
          tier: o.tier ?? null,
          offeredAt: o.offeredAt,
          firstForPlayer: !!o.firstForPlayer,
          firstP4ForPlayer: !!o.firstP4ForPlayer,
          firstG5ForPlayer: !!o.firstG5ForPlayer,
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
        // Cap the list so a heavily-offered player's detail stays light.
        offers: (offersByPlayer.get(p.id) || []).slice(0, 30),
      });
    }
    if (wire.offers) {
      for (const o of wire.offers) {
        o.player = bioMap.get(o.playerId) || null;
        // Carry state from player bio if offer itself has none
        if (!o.state && o.player?.state) o.state = o.player.state;
      }
    }
    fs.writeFileSync(wirePath, JSON.stringify(wire));
    n++; // count enrichment as a touched file for logging
  }
} catch (e) {
  console.error('build-site: failed to enrich wire.json:', e.message);
}
console.log(`build-site: ${n} file(s)`);

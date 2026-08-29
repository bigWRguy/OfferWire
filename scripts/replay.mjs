// Replay archived posts through the ACTUAL extraction chain — no network, no search
// budget, and no drift from src/pipeline.js.
//
// This used to carry its own copy of the extraction logic, which silently fell out of
// sync with src/pipeline.js and made every precision measurement taken against it
// measure the wrong code. It now imports prefilter() and rulesOnlyOffers() directly, so
// a change to pipeline.js is reflected here with zero duplication.
//
//   node scripts/replay.mjs            # funnel summary + offers
//   node scripts/replay.mjs --rejected # also show what the rules prefilter threw away
import fs from 'node:fs';
import path from 'node:path';
import { prefilter, rulesOnlyOffers } from '../src/pipeline.js';
import { byId } from '../src/resolve/schools.js';
import { DATA } from '../src/lib/store.js';

const showRejected = process.argv.includes('--rejected');

const dir = path.join(DATA, 'raw');
if (!fs.existsSync(dir)) {
  console.error('No data/raw/*.ndjson yet. Run the wire once first.');
  process.exit(1);
}
const posts = fs.readdirSync(dir).flatMap((f) =>
  fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

// prefilter() logs its own funnel line; capture it instead of printing twice.
let prefilterLine = '';
const candidates = prefilter(posts, (s) => { prefilterLine = s; });

const funnel = { total: posts.length, noSignalOrHardNeg: posts.length - candidates.length, candidates: candidates.length, noOfferMade: 0, accepted: 0 };
const offers = [];
const rejected = [];

for (const p of candidates) {
  const recs = rulesOnlyOffers(p);
  if (!recs.length) {
    funnel.noOfferMade++;
    if (showRejected) rejected.push([`no-offer(${p._rules.kind})`, p]);
    continue;
  }
  for (const rec of recs) {
    const school = byId.get(rec.school_id);
    funnel.accepted++;
    offers.push({
      school: school?.name || rec.school_id,
      who: rec.player_name || '@' + rec.player_handle,
      kind: p._rules.kind,
      conf: rec.confidence,
      cls: rec.class_year,
      pos: rec.position,
      text: p.text,
    });
  }
}

console.log('=== funnel ===');
for (const [k, v] of Object.entries(funnel)) console.log(`  ${k.padEnd(18)} ${v}`);
console.log(`  ${prefilterLine.trim()}`);
console.log(`  yield: ${((funnel.accepted / Math.max(1, funnel.total)) * 100).toFixed(1)}% of all posts`);

console.log(`\n=== offers (${offers.length}) ===`);
for (const o of offers) {
  console.log(`  ${o.school.padEnd(19)} <- ${o.who.padEnd(24)} ${String(o.cls ?? '').padEnd(5)}${(o.pos ?? '').padEnd(5)} ${o.kind} ${o.conf}`);
}

if (showRejected) {
  console.log(`\n=== rejected (${rejected.length}) ===`);
  for (const [why, p] of rejected.slice(0, 40)) {
    console.log(`  [${why}] ${p.text.replace(/\n/g, ' ').slice(0, 105)}`);
  }
}

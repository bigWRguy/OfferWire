import fs from 'node:fs';
import path from 'node:path';
import { prefilter, rulesOnlyOffers, rulesOnlyRejectionReason } from '../src/pipeline.js';
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

let prefilterLine = '';
const audit = { prefilter: { accepted: 0, rejected: 0, reasons: {}, samples: [] } };
const candidates = prefilter(posts, (s) => { prefilterLine = s; }, audit);

const funnel = { total: posts.length, noSignalOrHardNeg: posts.length - candidates.length, candidates: candidates.length, noOfferMade: 0, accepted: 0 };
const offers = [];
const rejected = [];

const extractionReasons = {};
for (const p of candidates) {
  const recs = rulesOnlyOffers(p);
  if (!recs.length) {
    funnel.noOfferMade++;
    const reason = rulesOnlyRejectionReason(p);
    extractionReasons[reason] = (extractionReasons[reason] || 0) + 1;
    if (showRejected) rejected.push([reason, p]);
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
console.log('\n=== prefilter rejection reasons ===');
for (const [reason, count] of Object.entries(audit.prefilter.reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(30)} ${count}`);
}

console.log('\n=== extraction rejection reasons ===');
for (const [reason, count] of Object.entries(extractionReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(38)} ${count}`);
}
console.log(`\n=== offers (${offers.length}) ===`);
for (const o of offers) {
  console.log(`  ${o.school.padEnd(19)} <- ${o.who.padEnd(24)} ${String(o.cls ?? '').padEnd(5)}${(o.pos ?? '').padEnd(5)} ${o.kind} ${o.conf}`);
}

if (showRejected) {
  const near = ['player_missing_class_year', 'player_missing_football_context', 'player_missing_position',
    'reporter_missing_class_year', 'reporter_missing_position', 'reporter_missing_player_name',
    'player_display_name_unusable', 'author_not_recruit:no recruit fields', 'author_not_recruit:not high-school recruit'];
  const byReason = new Map();
  for (const [reason, p] of rejected) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(p);
  }
  const order = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .sort((a, b) => Number(near.includes(b[0])) - Number(near.includes(a[0])));
  console.log(`\n=== rejected by reason (${rejected.length} total, ${order.length} reasons) ===`);
  for (const [reason, ps] of order) {
    const isNear = near.includes(reason);
    const shown = isNear ? 8 : 3;
    console.log(`\n[${reason}] (${ps.length})${isNear ? '  <- most likely real recruits, worth reading' : ''}`);
    for (const p of ps.slice(0, shown)) {
      console.log(`  @${p.author}: ${String(p.text).replace(/\s+/g, ' ').slice(0, 115)}`);
      if (p.authorBio) console.log(`    BIO: ${String(p.authorBio).replace(/\s+/g, ' ').slice(0, 96)}`);
    }
    if (ps.length > shown) console.log(`  … ${ps.length - shown} more`);
  }
}

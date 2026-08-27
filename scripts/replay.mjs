// Replay archived posts through the extraction chain — no network, no search budget.
//
// The wire keeps every post it ever collected in data/raw/*.ndjson precisely so that
// extraction changes can be measured against real data instead of guessed at. This
// prints the funnel and the resulting offers, so a change to rules.js can be judged in
// seconds rather than by burning a rate-limit window.
//
//   node scripts/replay.mjs            # funnel summary + offers
//   node scripts/replay.mjs --rejected # also show what was thrown away and why
import fs from 'node:fs';
import path from 'node:path';
import { classify, findClassYear, findPosition, findTaggedRecruit, findReportedName } from '../src/extract/rules.js';
import { findSchools, byId, SCHOOLS } from '../src/resolve/schools.js';
import { looksLikeRecruit, parseBio } from '../src/resolve/players.js';
import { CONFIG, DATA } from '../src/lib/store.js';

const showRejected = process.argv.includes('--rejected');
const acc = JSON.parse(fs.readFileSync(path.join(CONFIG, 'accounts.json'), 'utf8'));
const SCH = new Set(SCHOOLS.map((s) => s.handle.toLowerCase()));
const KNOWN = new Set([...(acc.reporters || []), ...(acc.aggregators || []), ...(acc.stateScouts?.handles || [])]
  .map((h) => String(h).toLowerCase()));

const dir = path.join(DATA, 'raw');
if (!fs.existsSync(dir)) {
  console.error('No data/raw/*.ndjson yet. Run the wire once first.');
  process.exit(1);
}
const posts = fs.readdirSync(dir).flatMap((f) =>
  fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

const funnel = { total: posts.length, noOfferWord: 0, hardNegative: 0, noVoice: 0, noSchool: 0, multiSchool: 0, noPlayerId: 0, notRecruit: 0, accepted: 0 };
const offers = [];
const rejected = [];

for (const p of posts) {
  if (!/offer/i.test(p.text)) { funnel.noOfferWord++; continue; }
  const c = classify(p.text);
  if (c.hardNegative) { funnel.hardNegative++; continue; }
  if (!c.kind) { funnel.noVoice++; continue; }

  const hay = `${p.text} ${(p.mentions || []).map((m) => '@' + m).join(' ')} ${(p.hashtags || []).map((h) => '#' + h).join(' ')}`;
  const solid = findSchools(hay).filter((s) => s.id && s.confidence >= 0.9);
  if (!solid.length) { funnel.noSchool++; continue; }
  if (solid.length > 1) { funnel.multiSchool++; rejected.push(['multi-school ' + solid.map((s) => s.id).join('/'), p]); continue; }
  const school = byId.get(solid[0].id);

  let name = null, handle = null, conf = 0.45;
  if (c.kind === 'player_voice') {
    const v = looksLikeRecruit(p.authorBio, p.authorName);
    if (!v.ok) { funnel.notRecruit++; rejected.push(['not-recruit:' + v.why, p]); continue; }
    handle = p.author;
    const dn = (p.authorName || '').replace(/[^\p{L}\p{M}'.\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (/^[\p{Lu}][\p{L}'.-]+(?:\s+[\p{Lu}][\p{L}'.-]+){1,2}$/u.test(dn)) name = dn;
  } else {
    const tagged = findTaggedRecruit(p, SCH, KNOWN);
    name = tagged?.name || (c.kind === 'reporter_voice' ? findReportedName(p.text) : null);
    handle = tagged?.handle || null;
    if (!name && !handle) { funnel.noPlayerId++; rejected.push(['no-player-id(' + c.kind + ')', p]); continue; }
    conf = tagged ? 0.6 : 0.5;
  }
  funnel.accepted++;
  const bio = handle && handle === p.author ? parseBio(p.authorBio) : {};
  offers.push({
    school: school.name,
    who: name || '@' + handle,
    kind: c.kind,
    conf,
    cls: findClassYear(p.text) ?? bio.classYear ?? null,
    pos: findPosition(p.text) ?? bio.position ?? null,
  });
}

console.log('=== funnel ===');
for (const [k, v] of Object.entries(funnel)) console.log(`  ${k.padEnd(14)} ${v}`);
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

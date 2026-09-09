import fs from 'node:fs';
import path from 'node:path';
import { DATA, decodeEntities } from '../src/lib/store.js';
import { findSchools, explicitNonFbsOfferTarget, foreignInstitution, namePhrases, byId, norm } from '../src/resolve/schools.js';
import { offerSpan, resolveOfferTarget } from '../src/resolve/attribution.js';

const offers = JSON.parse(fs.readFileSync(path.join(DATA, 'offers.json'), 'utf8'));
const showPairs = process.argv.includes('--pairs');

function writtenTarget(text) {
  const span = offerSpan(text);
  if (span.form === 'whole') return null;
  const spanText = span.text.replace(/@[A-Za-z0-9_]+/g, ' ').replace(/#[A-Za-z0-9_]+/g, ' ');
  const inSpan = namePhrases(spanText);
  if (!inSpan.length) return null;
  return (span.form === 'object' ? inSpan.slice(0, 3) : inSpan.slice(-3))
    .map((p) => p.text.replace(/\s+/g, ' ').trim());
}

const GENERIC = new Set(['the', 'of', 'at', 'university', 'universities', 'univ', 'u', 'college',
  'football', 'fb', 'athletics', 'program', 'staff', 'and', 'a', 'an', 'to', 'for', 'my', 'via',
  'coach', 'from', 'by', 'official', 'd1', 'division', 'i', 'blessed', 'receive', 'received',
  'extremely', 'thank', 'you', 'go', 'agtg', 'first', 'second', 'third', 'st', 'nd', 'rd', 'th']);

const flags = [];
const pairs = new Map();
let noEvidence = 0;

for (const o of offers) {
  const ev = (o.evidence || [])[0];
  if (!ev?.text) { noEvidence++; continue; }
  const text = decodeEntities(ev.text);
  const school = byId.get(o.schoolId);
  const resolved = findSchools(text).filter((s) => s.id).map((s) => s.id);
  const target = writtenTarget(text);

  const add = (why) => flags.push({ why, id: o.id, school: o.schoolName, player: o.playerName, target: target && target.join(' | '), url: ev.url, text: text.replace(/\s+/g, ' ').slice(0, 200) });

  const taggedOwnHandle = school && new RegExp(`@${school.handle}\\b`, 'i').test(text);
  if (target && !taggedOwnHandle) {
    const schoolWords = new Set([school?.name, school?.nickname, school?.handle, ...(school?.aliases || [])]
      .filter(Boolean).flatMap((v) => norm(v).split(' ')));
    const own = new Set([...GENERIC, ...schoolWords]);
    for (const written of target) {
      const words = norm(written).split(' ').filter(Boolean);
      if (!words.some((w) => schoolWords.has(w))) continue;
      const leftover = words.filter((w) => !own.has(w));
      if (leftover.length) { add(`written name has words that are not this school: ${JSON.stringify(leftover.join(' '))}`); break; }
    }
  }

  if (target) {
    const namesIt = target.some((x) => findSchools(x).some((s) => s.id === o.schoolId))
      || findSchools(offerSpan(text).text).some((s) => s.id === o.schoolId);
    const foreign = target.every((x) => foreignInstitution(x));
    const key = `${o.schoolId} <= ${target.map(norm).join(' | ')}`;
    if (!pairs.has(key)) pairs.set(key, { school: o.schoolName, target, n: 0, foreign, url: ev.url });
    pairs.get(key).n++;
    if (namesIt) {  }
    else if (foreign) add('offer target is a different institution');
    else if (!new RegExp(`@\\w*${school?.handle}\\b`, 'i').test(text)) add('offer target does not name the filed school');
  }
  if (!resolved.includes(o.schoolId) && !(o.evidence || []).some((e) => findSchools(decodeEntities(e.text || '')).some((s) => s.id === o.schoolId))) {
    add('filed school is not in the evidence at all');
  }
  if (explicitNonFbsOfferTarget(text)) add('post names a non-FBS offer source');
}

const byWhy = new Map();
for (const f of flags) byWhy.set(f.why, [...(byWhy.get(f.why) || []), f]);

console.log(`ledger: ${offers.length} published offers, ${noEvidence} with no evidence text`);
console.log(`flagged: ${new Set(flags.map((f) => f.id)).size} distinct offers, ${flags.length} findings\n`);
for (const [why, list] of [...byWhy].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`=== ${why} (${list.length}) ===`);
  for (const f of list) console.log(`  [${f.school}] <- ${f.player} | target=${JSON.stringify(f.target)}\n     ${f.text}`);
  console.log('');
}
if (showPairs) {
  console.log(`=== every distinct (filed school <= written institution) pair (${pairs.size}) ===`);
  for (const [k, v] of [...pairs].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${v.foreign ? 'FOREIGN' : 'ok     '} x${String(v.n).padStart(3)}  ${k}`);
}
process.exitCode = flags.length ? 1 : 0;

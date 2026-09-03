// EXHAUSTIVE attribution audit of the published ledger.
//
// This exists because the previous audit was worthless in a specific, repeatable way:
// it diffed old-vs-new resolver behaviour and eyeballed 40 random rows out of 1,311.
// A diff cannot see a bug that is present in BOTH versions, and a 3% sample cannot see
// anything rare. "Alabama A &amp; M university" was filed as an Alabama P4 offer and
// was invisible to both checks.
//
// So this audit does the opposite:
//   * it reads data/offers.json - what the site actually publishes - not raw posts;
//   * it checks EVERY row, and reports ENTIRE categories, never a sample;
//   * its central check does not trust the resolver. For each offer it reads the
//     institution name written after the offer verb, and asks whether the school we
//     filed it under is that whole name. Every distinct (filed school, written name)
//     pair is printed, so a new failure mode shows up as a new pair rather than
//     hiding inside a row count.
//
//   node scripts/audit-attribution.mjs           # summary + every flagged row
//   node scripts/audit-attribution.mjs --pairs   # every distinct school/name pair
import fs from 'node:fs';
import path from 'node:path';
import { DATA, decodeEntities } from '../src/lib/store.js';
import { findSchools, explicitNonFbsOfferTarget, foreignInstitution, namePhrases, byId, norm } from '../src/resolve/schools.js';
import { offerSpan, resolveOfferTarget } from '../src/resolve/attribution.js';

const offers = JSON.parse(fs.readFileSync(path.join(DATA, 'offers.json'), 'utf8'));
const showPairs = process.argv.includes('--pairs');

// The institution the POST names as the offerer, read with the same span rule the wire
// uses: after the verb for "offer from X", before it for "X has offered". Reading
// everything after a bare "from" was wrong - in "Wake Forest has offered OT Roman
// Maurizio from Central Catholic HS" that is the recruit's high school.
function writtenTarget(text) {
  const span = offerSpan(text);
  if (span.form === 'whole') return null;
  // @handles are not written names - the resolver reads them exactly, in its own pass -
  // and the tag pile at the end of a post is not the offer target.
  const spanText = span.text.replace(/@[A-Za-z0-9_]+/g, ' ');
  const inSpan = namePhrases(spanText);
  if (!inSpan.length) return null;
  // EVERY name written in the span, nearest the verb first. A row is suspect only when
  // none of them is the school it was filed under: "(UNC) Charlotte" opens with a
  // shorter, different name and is still a Charlotte offer.
  return (span.form === 'object' ? inSpan.slice(0, 3) : inSpan.slice(-3))
    .map((p) => p.text.replace(/\s+/g, ' ').trim());
}

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

  // 1. The post names an institution that is NOT this school.
  if (target) {
    // Also check the span as a whole: a lowercase lead-in ("the university of Miami")
    // leaves only "Miami" as a capitalised phrase, which is ambiguous on its own.
    const namesIt = target.some((x) => findSchools(x).some((s) => s.id === o.schoolId))
      || findSchools(offerSpan(text).text).some((s) => s.id === o.schoolId);
    const foreign = target.every((x) => foreignInstitution(x));
    const key = `${o.schoolId} <= ${target.map(norm).join(' | ')}`;
    if (!pairs.has(key)) pairs.set(key, { school: o.schoolName, target, n: 0, foreign, url: ev.url });
    pairs.get(key).n++;
    if (namesIt) { /* the post names this school as the offerer */ }
    else if (foreign) add('offer target is a different institution');
    else if (!new RegExp(`@\\w*${school?.handle}\\b`, 'i').test(text)) add('offer target does not name the filed school');
  }
  // 2. The filed school no longer resolves anywhere in the post.
  if (!resolved.includes(o.schoolId) && !(o.evidence || []).some((e) => findSchools(decodeEntities(e.text || '')).some((s) => s.id === o.schoolId))) {
    add('filed school is not in the evidence at all');
  }
  // 3. The post is an explicit non-FBS offer.
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

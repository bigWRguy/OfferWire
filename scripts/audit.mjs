// Reads the committed per-run audit trail (data/audit/*.ndjson) and prints the big
// picture: the funnel over time, the rejection-reason census, and the recruit-shaped
// near-misses that are most likely REAL PLAYERS being thrown away.
//
//   node scripts/audit.mjs                     # everything, all runs
//   node scripts/audit.mjs --since 2026-08-28  # only runs from that day on
//
// This is the "what have we done" half. The second half — full post text of every
// rejected candidate, grouped by reason, straight off the archive — is
//   node scripts/replay.mjs --rejected     # (npm run audit runs both)
//
// The improvement loop: skim the near-miss reasons here, read the offending posts in
// replay, fix the rule, re-measure with replay, commit. data/audit/ is committed with
// every run, so the trend is permanently diffable in git.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../src/lib/store.js';

// Reasons that mean a post LOOKED like a real recruit offer but got dropped anyway.
// These are the false-negative candidates — read the samples, decide if a rule fix is
// warranted, then re-measure with `node scripts/replay.mjs --rejected`.
const RECRUIT_SHAPED = [
  'player_missing_class_year',
  'player_missing_football_context',
  'reporter_missing_class_year',
  'reporter_missing_position',
  'reporter_missing_player_name',
  'player_display_name_unusable',
  'author_not_recruit:no recruit fields',
];

const sinceArg = process.argv.indexOf('--since');
const since = sinceArg >= 0 ? process.argv[sinceArg + 1] : null;
const dir = path.join(DATA, 'audit');
if (!fs.existsSync(dir) || !fs.readdirSync(dir).length) {
  console.error('No data/audit/*.ndjson yet. Run the wire once first.');
  process.exit(1);
}

const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !since || String(r.at || '').slice(0, 10) >= since);

const tally = (map, reasons) => { for (const [k, v] of Object.entries(reasons || {})) map.set(k, (map.get(k) || 0) + v); };

const funnel = { collected: 0, kept: 0, duplicate: 0, candidates: 0, accepted: 0, rejected: 0, newOffers: 0 };
const preReasons = new Map();
const extReasons = new Map();
const search = { ok: 0, fail: 0, jobs: 0, requests: 0, sweeps: 0 };
const days = new Map();
const missSamples = new Map();

for (const r of runs) {
  const c = r.collection || {}, pre = r.prefilter || {}, ex = r.extraction || {},
    o = r.outcome || {}, s = r.search || {};
  funnel.collected += c.returned || 0;
  funnel.kept += c.kept || 0;
  funnel.duplicate += c.duplicate || 0;
  funnel.candidates += pre.accepted || 0;
  funnel.accepted += ex.accepted || 0;
  funnel.rejected += ex.rejected || 0;
  funnel.newOffers += o.brandNewOffers || 0;
  tally(preReasons, pre.reasons);
  tally(extReasons, ex.reasons);
  if (s.ok) search.ok++; else if (s.ok === false) search.fail++;
  search.jobs += s.jobs || 0;
  search.requests += s.requests || 0;
  search.sweeps += s.swept || 0;
  const day = String(r.at || '').slice(0, 10);
  const d = days.get(day) || { runs: 0, collected: 0, kept: 0, cand: 0, acc: 0, rej: 0, new: 0 };
  d.runs++; d.collected += c.returned || 0; d.kept += c.kept || 0;
  d.cand += pre.accepted || 0; d.acc += ex.accepted || 0; d.rej += ex.rejected || 0;
  d.new += o.brandNewOffers || 0;
  days.set(day, d);
  if (!missSamples.has(day)) missSamples.set(day, new Map());
  const dayMiss = missSamples.get(day);
  for (const [reason, count] of Object.entries(ex.reasons || {})) {
    if (!RECRUIT_SHAPED.includes(reason)) continue;
    if (!dayMiss.has(reason)) dayMiss.set(reason, { count: 0, samples: [] });
    dayMiss.get(reason).count += count;
    for (const s of ex.samples || []) {
      if (s.reason === reason && dayMiss.get(reason).samples.length < 6) dayMiss.get(reason).samples.push(s);
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);

console.log(`OfferWire audit — ${runs.length} runs in data/audit/*.ndjson${since ? ` since ${since}` : ''}\n`);
console.log('=== search health ===');
console.log(`  runs ok: ${search.ok}  failed: ${search.fail}  jobs swept: ${search.sweeps}  requests: ${search.requests}`);
console.log(`  yield: ${funnel.candidates ? ((funnel.accepted / funnel.candidates) * 100).toFixed(1) : 0}% of candidates became accepted evidence\n`);

console.log('=== cumulative funnel ===');
for (const [k, v] of Object.entries(funnel)) console.log(`  ${pad(k, 12)} ${v}`);

console.log('=== per-day ===');
console.log(`  ${pad('date', 10)} ${pad('runs', 4)} ${pad('collected', 9)} ${pad('kept', 6)} ${pad('cand', 6)} ${pad('accept', 7)} ${pad('reject', 7)} ${pad('new', 4)}`);
for (const [day, d] of [...days.entries()].sort()) {
  console.log(`  ${pad(day, 10)} ${pad(d.runs, 4)} ${pad(d.collected, 9)} ${pad(d.kept, 6)} ${pad(d.cand, 6)} ${pad(d.acc, 7)} ${pad(d.rej, 7)} ${pad(d.new, 4)}`);
}

const reasonTable = (title, map) => {
  console.log(`\n=== ${title} ===`);
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = RECRUIT_SHAPED.includes(k) ? '  <- recruit-shaped' : '';
    console.log(`  ${pad(k, 38)} ${v}${flag}`);
  }
  console.log(`  ${pad('TOTAL', 38)} ${total}`);
};
reasonTable('prefilter rejection reasons', preReasons);
reasonTable('extraction rejection reasons', extReasons);

console.log('\n=== recruit-shaped misses (real players possibly being thrown away) ===');
for (const [day, dayMiss] of [...missSamples.entries()].sort()) {
  const lines = [];
  for (const [reason, info] of [...dayMiss.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`  ${pad(reason, 38)} ${info.count}`);
  }
  if (!lines.length) continue;
  console.log(`\n${day}:`);
  for (const l of lines) console.log(l);
}
const latestDay = [...missSamples.keys()].sort().pop();
if (latestDay) {
  console.log('\nSample posts (most recent day, first 6 per reason — full text in "npm run replay -- --rejected"):\n');
  for (const [reason, info] of missSamples.get(latestDay)) {
    if (!info.samples.length) continue;
    console.log(`· ${reason}`);
    for (const s of info.samples) {
      console.log(`    @${s.author || '?'} [${s.postId || ''}] ${String(s.text || '').replace(/\s+/g, ' ').slice(0, 130)}`);
    }
  }
}

const review = path.join(DATA, 'review.ndjson');
if (fs.existsSync(review)) {
  const n = fs.readFileSync(review, 'utf8').split('\n').filter(Boolean).length;
  console.log('\n=== ambiguous merges waiting for a human ===');
  console.log(`  data/review.ndjson: ${n} rows ("npm run wire" keeps appending)`);
}

console.log('\nNext step: "npm run replay -- --rejected" re-extracts the archive and prints every\nrejected candidate grouped by reason so you can decide whether a rule is the problem.');
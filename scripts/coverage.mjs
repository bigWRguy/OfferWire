// Coverage planner.
//
// The one number that decides whether this wire is useful: how long between an offer
// being posted and the sweep reaching the school it belongs to. That is set entirely by
// how many search requests the credential pool can spend per 15-minute window.
//
// This prints the honest arithmetic for your current pool, and what you'd need for a
// target latency. Run it before you trust the wire's freshness.
//
//   node scripts/coverage.mjs             # plan against configured credentials
//   node scripts/coverage.mjs 3           # plan as if you had 3 credentials
import { allJobs, schoolJobs, phraseJobs, classJobs } from '../src/collect/queries.js';
import { loadCredentials } from '../src/collect/search.js';
import { readJson } from '../src/lib/store.js';

const jobs = allJobs();
const creds = loadCredentials();
const nCreds = Number(process.argv[2]) || creds.length || 0;

// Measured in production: this web session rate-limited on request 38. Plan at 37 so
// the final query succeeds and advances its watermark instead of spending a call on 429.
const PER_WINDOW = Number(process.env.OFFERWIRE_PER_WINDOW || 37);
const WINDOW_MIN = 15;
const CRON_MIN = Number(process.env.OFFERWIRE_CRON_MIN || 15);

console.log('== job set ==');
console.log(`  per-school jobs : ${schoolJobs().length}   (the spine — every FBS program, every sweep)`);
console.log(`  phrase jobs     : ${phraseJobs().length}`);
console.log(`  class jobs      : ${classJobs().length}`);
console.log(`  TOTAL           : ${jobs.length}`);
console.log('');
console.log('  Each job costs 1 request in the quiet case. A job with more new posts than');
console.log('  fit on one page costs another request per extra page (budget: 3).');

console.log('\n== credentials ==');
if (!nCreds) {
  console.log('  NONE CONFIGURED. Search cannot run, and without search this system is');
  console.log('  just a slower version of following the same accounts everyone follows.');
} else {
  console.log(`  ${nCreds} credential(s)${creds.length ? ': ' + creds.map((c) => `${c.id} (${c.kind})`).join(', ') : ' (hypothetical)'}`);
}

const perWindow = nCreds * PER_WINDOW;
const perCycle = Math.floor(perWindow * (CRON_MIN / WINDOW_MIN));

console.log('\n== throughput ==');
console.log(`  budget           : ${PER_WINDOW} requests / ${WINDOW_MIN} min / credential`);
console.log(`  pool capacity    : ${perWindow} requests / ${WINDOW_MIN} min`);
console.log(`  cron cadence     : every ${CRON_MIN} min`);
console.log(`  spend per cycle  : ~${perCycle} requests`);

if (perCycle > 0) {
  // Assume ~1.25 requests per job on average (most jobs are one page; a few page twice).
  const jobsPerCycle = Math.floor(perCycle / 1.25);
  const cycles = Math.ceil(jobs.length / Math.max(1, jobsPerCycle));
  const latency = cycles * CRON_MIN;
  console.log(`  jobs per cycle   : ~${jobsPerCycle}`);
  console.log(`  full sweep takes : ${cycles} cycle(s) = ~${latency} min`);
  console.log('');
  console.log(`  >> Worst-case latency from offer posted to offer in the ledger: ~${latency} min.`);
  console.log('  >> Nothing is LOST at any pool size — each school carries its own since_time');
  console.log('  >> watermark, so a school swept 40 min ago asks for the last 40 min. Pool size');
  console.log('  >> buys LATENCY, not completeness.');
}

console.log('\n== what you need for a target latency ==');
for (const target of [10, 20, 30, 60]) {
  const cyclesAllowed = Math.max(1, Math.floor(target / CRON_MIN));
  const jobsNeeded = Math.ceil(jobs.length / cyclesAllowed);
  const reqNeeded = Math.ceil(jobsNeeded * 1.25);
  const needCreds = Math.ceil(reqNeeded / (PER_WINDOW * (CRON_MIN / WINDOW_MIN)));
  const mark = nCreds >= needCreds ? 'OK' : `need ${needCreds - nCreds} more`;
  console.log(`  ~${String(target).padStart(3)} min full sweep : ${needCreds} credential(s)   [${mark}]`);
}

const state = readJson('state.json', {});
if (state.watermarks) {
  const marks = state.watermarks;
  const ages = schoolJobs().map((j) => {
    const at = marks[j.key]?.at;
    return { id: j.key, h: at ? (Date.now() - new Date(at).getTime()) / 36e5 : Infinity };
  });
  const never = ages.filter((a) => a.h === Infinity).length;
  const covered = ages.filter((a) => a.h !== Infinity);
  console.log('\n== actual coverage right now ==');
  console.log(`  schools never swept : ${never}/${ages.length}`);
  if (covered.length) {
    const worst = covered.sort((a, b) => b.h - a.h)[0];
    const median = covered[Math.floor(covered.length / 2)];
    console.log(`  median staleness    : ${median.h.toFixed(1)}h`);
    console.log(`  worst staleness     : ${worst.h.toFixed(1)}h  (${worst.id})`);
  }
  if (state.searchCoverage) {
    console.log(`  last run swept      : ${state.searchCoverage.sweptThisRun}/${state.searchCoverage.jobsTotal} jobs in ${state.searchCoverage.requests} requests`);
  }
}

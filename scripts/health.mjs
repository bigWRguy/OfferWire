import fs from 'node:fs';
import path from 'node:path';
import { fetchList, fetchProfile, lagHours } from '../src/collect/x.js';
import { loadCredentials } from '../src/collect/search.js';
import { schoolJobs, allJobs, backfillJobs, backfillProgress } from '../src/collect/queries.js';
import { CONFIG, readJson } from '../src/lib/store.js';

const cfg = (f) => JSON.parse(fs.readFileSync(path.join(CONFIG, f), 'utf8'));
const fmt = (h) => (h === Infinity ? 'never' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`);
let problems = 0;

console.log('== SEARCH (the engine) ==');
const creds = loadCredentials();
if (!creds.length) {
  problems++;
  console.log('  NOT CONFIGURED — the wire cannot do its job.');
  console.log('  Per-school search is what finds recruits nobody has covered. Without it you');
  console.log('  only see posts from accounts you already follow, which is the coverage the');
  console.log('  services already have. Set X_AUTH_TOKEN + X_CT0 or X_SESSIONS.');
} else {
  console.log(`  ${creds.length} credential(s): ${creds.map((c) => `${c.id} (${c.kind})`).join(', ')}`);
  const { SearchSession } = await import('../src/collect/search.js');
  const s = new SearchSession(creds[0]);
  try {
    await s.open();
    const r = await s.search('"blessed to receive an offer" -filter:retweets');
    if (r.ok) console.log(`  live probe OK — ${r.posts.length} posts returned`);
    else { problems++; console.log(`  LIVE PROBE FAILED: ${r.error}`); }
  } catch (e) { problems++; console.log(`  LIVE PROBE ERROR: ${e.message}`); }
  finally { await s.close(); }
}

console.log('\n== PER-SCHOOL COVERAGE ==');
const state = readJson('state.json', {});
const marks = state.watermarks || {};
const schools = schoolJobs();
const ages = schools.map((j) => {
  const at = marks[j.key]?.at;
  return { id: j.key, h: at ? (Date.now() - new Date(at).getTime()) / 36e5 : Infinity, truncated: marks[j.key]?.truncated };
});
const never = ages.filter((a) => a.h === Infinity);
const seen = ages.filter((a) => a.h !== Infinity).sort((a, b) => b.h - a.h);
console.log(`  ${seen.length}/${schools.length} schools have been swept at least once`);
if (never.length) {
  problems++;
  console.log(`  NEVER SWEPT (${never.length}): ${never.slice(0, 12).map((a) => a.id).join(', ')}${never.length > 12 ? ' …' : ''}`);
}
if (seen.length) {
  const median = seen[Math.floor(seen.length / 2)];
  console.log(`  median staleness: ${fmt(median.h)}   worst: ${fmt(seen[0].h)} (${seen[0].id})`);
  const bad = seen.filter((a) => a.h > 3);
  if (bad.length) {
    problems++;
    console.log(`  ${bad.length} school(s) stale >3h — pool is undersized for the cadence. Run:`);
    console.log('    node scripts/coverage.mjs   (tells you how many credentials you need)');
  }
  const trunc = ages.filter((a) => a.truncated);
  if (trunc.length) {
    console.log(`  ${trunc.length} school(s) truncated on their last sweep (more posts than the page`);
    console.log('  budget). Their watermark only advanced as far as actually covered, so nothing');
    console.log('  is lost — but raise OFFERWIRE_SCROLLS or add credentials if this persists.');
  }
}
if (state.searchCoverage) {
  const c = state.searchCoverage;
  console.log(`  last run: swept ${c.sweptThisRun}/${c.jobsTotal} jobs in ${c.requests} requests (~${c.fullSweepCycles} cycles per full pass)`);
}
if (state.backfill) {
  const anchor = new Date(state.backfillAnchorAt || state.firstRunAt || Date.now());
  const b = state.backfill.totalWindows != null
    ? state.backfill
    : { ...state.backfill, ...backfillProgress(backfillJobs(state.backfill.days || 30, anchor), marks) };
  const done = b.completedWindows ?? b.completedTeamDays;
  const total = b.totalWindows ?? b.totalTeamDays;
  const left = b.remainingWindows ?? b.remainingTeamDays;
  console.log(`  ${b.days || 30}-day backlog: ${done}/${total} school-windows complete (${left} remaining, ${b.chunkDays || 1}-day chunks)`);
}
if (state.lastAudit) {
  const a = state.lastAudit;
  console.log(`  last funnel: ${a.collection?.returned || 0} returned -> ${a.collection?.kept || 0} new -> ${a.prefilter?.accepted || 0} candidates -> ${a.extraction?.accepted || 0} accepted evidence`);
}
if (state.rateBudget) {
  console.log('  rate budget:');
  for (const [id, b] of Object.entries(state.rateBudget)) {
    const left = b.resetAt && Date.now() >= b.resetAt ? `${b.limit ?? '?'} (window rolled)` : `${b.remaining ?? '?'}/${b.limit ?? '?'}`;
    console.log(`    ${id}: ${left}${b.resetAt ? `, resets in ${Math.max(0, Math.round((b.resetAt - Date.now()) / 60000))}m` : ''}`);
  }
}

console.log('\n== LISTS (corroboration) ==');
const lists = cfg('lists.json');
const active = (lists.lists || []).filter((l) => l.id && !l.disabled);
if (!active.length) {
  console.log('  none configured. Optional — Lists corroborate the sweep and cost no search');
  console.log('  budget, but they are not required for coverage.');
}
for (const l of active) {
  const r = await fetchList(l.id);
  if (!r.ok) { problems++; console.log(`  ${l.name}: DOWN (${r.error})`); continue; }
  const authors = new Set(r.posts.map((p) => p.author));
  const lag = lagHours(r.posts);
  console.log(`  ${l.name}: ${r.posts.length} posts / ${authors.size} authors / newest ${fmt(lag)} ago${lag > 6 ? '   <-- STALE, is the List public?' : ''}`);
  if (r.posts.length >= 65) console.log('     at the ~68-post ceiling — split this List or it is dropping posts between runs.');
}

console.log('\n== PROFILE WIDGETS (backfill only) ==');
const sample = process.argv.slice(2).length ? process.argv.slice(2) : ['TexasFootball', 'OhioStateFB', 'Hayesfawcett3', 'GeorgiaFootball'];
for (const h of sample) {
  const r = await fetchProfile(h);
  if (!r.ok) { console.log(`  @${h}: DOWN (${r.error})`); continue; }
  const lag = lagHours(r.posts);
  console.log(`  @${h}: ${r.posts.length} posts / newest ${fmt(lag)} ago${lag > 24 * 14 ? '   <-- FROZEN widget (expected; this is why search is the engine)' : ''}`);
}

console.log('\n== LEDGER ==');
const offers = readJson('offers.json', []);
const players = readJson('players.json', []);
const wl = readJson('watchlist.json', { handles: {} });
const promoted = Object.values(wl.handles || {}).filter((h) => h.promoted).length;
console.log(`  ${offers.length} offers / ${players.length} players / ${Object.keys(wl.handles || {}).length} watchlist handles (${promoted} promoted)`);
if (offers.length) {
  const newest = offers.reduce((a, o) => Math.max(a, new Date(o.offeredAt).getTime()), 0);
  console.log(`  newest offer: ${fmt((Date.now() - newest) / 36e5)} ago`);
  const corr = offers.filter((o) => o.corroborations > 1).length;
  console.log(`  corroborated by 2+ independent authors: ${corr} (${((corr / offers.length) * 100).toFixed(0)}%)`);
  const bySchool = {};
  for (const o of offers) bySchool[o.schoolId] = (bySchool[o.schoolId] || 0) + 1;
  console.log(`  schools represented: ${Object.keys(bySchool).length}/136`);
}

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll readers healthy.');
process.exit(problems ? 1 : 0);

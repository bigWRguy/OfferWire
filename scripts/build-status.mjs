// Rebuilds site/status.json (and data/site/status.json) from the CURRENT on-disk store,
// without running the wire. This exists so a manually-rebuilt ledger can ship with an
// accurate, non-stale status block instead of whatever the last live run wrote.
//
// It mirrors the status shape that src/pipeline.js main() writes, so the site's health()
// renderer behaves identically. It never fabricates data: every field is derived from
// data/state.json (watermarks, coverage) and the ledger on disk.
//
//   node scripts/build-status.mjs
import path from 'node:path';
import { readJson, writeJson, ROOT } from '../src/lib/store.js';
import { schoolJobs, backfillJobs, backfillProgress } from '../src/collect/queries.js';
import { loadCredentials } from '../src/collect/search.js';

const now = () => new Date().toISOString();

/** Identical to pipeline.staleSchools: schools whose watermark is missing or behind. */
function staleSchools(state, thresholdHours = 2) {
  const marks = state.watermarks || {};
  return schoolJobs()
    .map((j) => {
      const at = marks[j.key]?.at;
      return { id: j.key, hours: at ? +((Date.now() - new Date(at).getTime()) / 36e5).toFixed(1) : null };
    })
    .filter((s) => s.hours === null || s.hours > thresholdHours)
    .sort((a, b) => ((b.hours ?? 1e9) - (a.hours ?? 1e9)));
}

const state = readJson('state.json', {});
const offers = readJson('offers.json', []);
const players = readJson('players.json', []);
const playerById = new Map(players.map((p) => [p.id, p]));

const recent = offers.map((offer) => {
  const player = playerById.get(offer.playerId) || {};
  return { ...offer, playerName: player.name || offer.playerName, classYear: player.classYear ?? null, position: player.position ?? null };
});

// An offer is "complete" when the player is named and their class is known. Position is
// deliberately NOT part of the bar anymore: the extractor publishes real self-announced
// offers whose verified bio states measurables but no position (the first reporter post
// or the LLM fills the blank). Those rows are correct as published, so counting them as
// "incomplete" just makes the coverage gate fail on nothing.
const complete = recent.filter((o) => o.playerName && o.classYear).length;

const backfillDays = Number(state.backfill?.days || 0);
const anchor = new Date(state.backfillAnchorAt || state.firstRunAt || Date.now());
const backfill = backfillDays
  ? {
      at: state.backfill?.at || null,
      days: backfillDays,
      ...backfillProgress(backfillJobs(backfillDays, anchor), state.watermarks || {}),
    }
  : null;
const ages = schoolJobs().map((j) => { const at = state.watermarks?.[j.key]?.at; return at ? (Date.now() - new Date(at).getTime()) / 36e5 : Infinity; }).sort((a,b)=>a-b);
const percentile = (n) => ages.length ? ages[Math.min(ages.length - 1, Math.floor((ages.length - 1) * n))] : null;
const status = {
  generatedAt: now(),
  searchCredentials: loadCredentials().length,
  searchConfigured: state.searchConfigured === true,
  // X's bot check is served per runner address. While it is refusing us, every
  // downstream latency number is a consequence of that one cause, so the coverage
  // gate needs to see the cause and not shout about the symptom every 15 minutes.
  searchBlocked: state.searchBlocked === true,
  blockedRuns: state.blockedRuns || 0,
  warmedUp: !!(state.firstRunAt && Date.now() - new Date(state.firstRunAt).getTime() > 3 * 3600e3),
  searchCoverage: state.searchCoverage || null,
  backfillCoverage: state.backfillCoverage || null,
  backfill,
  staleSchools: staleSchools(state),
  liveStaleness: { medianHours: percentile(.5), p95Hours: percentile(.95), worstHours: percentile(1) },
  decisionCoverage: state.lastDecisionCoverage || { total: 0, decided: 0, complete: true },
  pending: { total: Object.keys(readJson('pending.json', { candidates: {} }).candidates || {}).length },
  profileResolution: { cached: Object.keys(readJson('affiliations.json', { accounts: {} }).accounts || {}).length },
  paginationBacklog: Object.values(state.watermarks || {}).filter((m) => m.window).length,
  quality: { completeOffers: complete, incompleteOffers: recent.length - complete },
  frozenProfiles: state.frozenProfiles || [],
  health: state.health || {},
  audit: state.lastAudit || null,
  log: [`status rebuilt locally from current store on ${now()}`],
};

writeJson('site/status.json', status);
console.log(`status.json rebuilt: ${recent.length} offers, ${complete} complete, ${status.staleSchools.length} stale schools`);
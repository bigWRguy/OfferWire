// Prints the exact handle rosters to paste into each X List, sharded so that no single
// List outruns the ~68-post window the syndication reader returns.
//
//   node scripts/plan-lists.mjs            # print all shards
//   node scripts/plan-lists.mjs --new      # only handles promoted since the last run
import fs from 'node:fs';
import path from 'node:path';
import { SCHOOLS } from '../src/resolve/schools.js';
import { CONFIG, readJson } from '../src/lib/store.js';

const accounts = JSON.parse(fs.readFileSync(path.join(CONFIG, 'accounts.json'), 'utf8'));
const wl = readJson('watchlist.json', { handles: {} });
const onlyNew = process.argv.includes('--new');

const SHARD = 50;
const shard = (arr, name) => {
  const out = [];
  for (let i = 0; i < arr.length; i += SHARD) {
    out.push({ name: arr.length > SHARD ? `${name}-${String.fromCharCode(97 + out.length)}` : name, handles: arr.slice(i, i + SHARD) });
  }
  return out;
};

const promoted = Object.values(wl.handles || {})
  .filter((h) => h.promoted)
  .sort((a, b) => b.score - a.score)
  .map((h) => h.handle);

const groups = [
  ...shard([...(accounts.reporters || []), ...(accounts.aggregators || [])], 'ow-reporters'),
  ...shard(SCHOOLS.map((s) => s.handle), 'ow-schools'),
  ...shard(accounts.stateScouts?.handles || [], 'ow-state-scouts'),
  ...shard(promoted, 'ow-players'),
];

if (onlyNew) {
  const since = process.env.SINCE || new Date(Date.now() - 7 * 864e5).toISOString();
  const recent = Object.values(wl.handles || {})
    .filter((h) => h.promoted && (h.promotedAt || '') > since)
    .map((h) => `@${h.handle}${h.name ? `  (${h.name}${h.classYear ? ' ' + h.classYear : ''}${h.position ? ' ' + h.position : ''})` : ''}`);
  console.log(`# Promoted since ${since} — add these to your ow-players list(s)\n`);
  console.log(recent.length ? recent.join('\n') : '(none)');
  process.exit(0);
}

console.log('# OfferWire — X List plan');
console.log('# Create each List on x.com, set it to PUBLIC, add the handles, then put the');
console.log('# numeric id from x.com/i/lists/<ID> into config/lists.json and flip disabled:false.\n');

for (const g of groups) {
  if (!g.handles.length) continue;
  console.log(`## ${g.name}  (${g.handles.length} accounts)`);
  console.log(g.handles.map((h) => '@' + h).join(' '));
  console.log('');
}

console.log(`# totals: ${groups.reduce((n, g) => n + g.handles.length, 0)} accounts across ${groups.filter((g) => g.handles.length).length} lists`);
if (!promoted.length) {
  console.log('# note: no promoted player accounts yet — those appear once the wire has run and');
  console.log('#       search has surfaced recruits announcing their own offers.');
}

import { byId, SCHOOLS } from './schools.js';

const P4_CONFERENCES = new Set(['SEC', 'B1G', 'B12', 'ACC']);
const P4_INDEPENDENT_IDS = new Set(['notre-dame']);
export function tierOf(school) {
  if (!school) return null;
  if (school.conference === 'IND') return P4_INDEPENDENT_IDS.has(school.id) ? 'P4' : 'G5';
  return P4_CONFERENCES.has(school.conference) ? 'P4' : 'G5';
}
for (const s of SCHOOLS) s.tier = tierOf(s);

export function decorateOffers(offers) {
  const byPlayer = new Map();
  for (const o of offers) {
    delete o.firstForPlayer; delete o.firstP4ForPlayer; delete o.firstG5ForPlayer;
    o.tier = tierOf(byId.get(o.schoolId));
    if (!byPlayer.has(o.playerId)) byPlayer.set(o.playerId, []);
    byPlayer.get(o.playerId).push(o);
  }
  const stats = new Map();
  for (const [pid, rows] of byPlayer) {
    const st = { total: rows.length, p4: rows.filter((o) => o.tier === 'P4').length, g5: rows.filter((o) => o.tier === 'G5').length };
    stats.set(pid, st);
  }
  return stats;
}

// Offer tiering (Power-4 vs Group-of-5) and per-player offer statistics.
//
// FBS teams divide into two recruiting realities that matter to recruits and readers:
//   P4  - the Power 4 conferences (ACC, Big Ten, Big 12, SEC) plus Notre Dame. These
//         are the blue-chip, national-broadcast programs; a "first P4 offer" is a
//         milestone every recruit's bio celebrates.
//   G5  - the Group of 5 (AAC, C-USA, MAC, Mountain West, Sun Belt) plus the other
//         independents and the two-school Pac, which recruit a different tier.
//
// decorateOffers() walks the FULL ledger once and, per player, marks:
//   o.tier                 P4 | G5 for every offer row
//   o.firstForPlayer       true on the player's earliest offer overall
//   o.firstP4ForPlayer     true on the player's earliest Power-4 offer
//   o.firstG5ForPlayer     true on the player's earliest Group-of-5 offer
// and returns per-player counts (total / P4 / G5) with the milestone timestamps.
// It is deterministic: rows are ordered by offeredAt, so rebuilds are byte-stable.
import { byId, SCHOOLS } from './schools.js';

const P4_CONFERENCES = new Set(['SEC', 'B1G', 'B12', 'ACC']);
// Independents: Notre Dame plays a Power schedule; everyone else (UConn, and the
// collapsed-Pac pair Oregon State / Washington State) is effectively G5.
const P4_INDEPENDENT_IDS = new Set(['notre-dame']);

export function tierOf(school) {
  if (!school) return null;
  if (school.conference === 'IND') return P4_INDEPENDENT_IDS.has(school.id) ? 'P4' : 'G5';
  return P4_CONFERENCES.has(school.conference) ? 'P4' : 'G5';
}

// Attach tier to every school record so it is queryable anywhere SCHOOLS is imported.
for (const s of SCHOOLS) s.tier = tierOf(s);

/**
 * Decorate offer rows with tier + first-milestone flags and compute per-player counts.
 * @param {Array} offers  full ledger rows (each has playerId, schoolId, offeredAt)
 * @returns {Map<string, {total,p4,g5,firstOfferAt,firstP4At,firstG5At}>}
 */
export function decorateOffers(offers) {
  const byPlayer = new Map();
  for (const o of offers) {
    if (!byPlayer.has(o.playerId)) byPlayer.set(o.playerId, []);
    byPlayer.get(o.playerId).push(o);
  }
  const stats = new Map();
  for (const [pid, rows] of byPlayer) {
    rows.sort((a, b) => new Date(a.offeredAt) - new Date(b.offeredAt));
    const st = { total: rows.length, p4: 0, g5: 0, firstOfferAt: null, firstP4At: null, firstG5At: null };
    let firstDone = false, p4Done = false, g5Done = false;
    for (const o of rows) {
      const tier = tierOf(byId.get(o.schoolId));
      o.tier = tier;
      if (!firstDone) { firstDone = true; o.firstForPlayer = true; st.firstOfferAt = o.offeredAt; }
      if (tier === 'P4') {
        st.p4++;
        if (!p4Done) { p4Done = true; o.firstP4ForPlayer = true; st.firstP4At = o.offeredAt; }
      } else if (tier === 'G5') {
        st.g5++;
        if (!g5Done) { g5Done = true; o.firstG5ForPlayer = true; st.firstG5At = o.offeredAt; }
      }
    }
    stats.set(pid, st);
  }
  return stats;
}
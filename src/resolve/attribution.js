// Deterministic offer-target attribution. Contextual school mentions are never targets.
import { SCHOOLS, HANDLES, findSchools, norm } from './schools.js';

const NON_FBS = /\b(?:eastern new mexico|wisconsin lutheran|wisconsin river falls|university of tennessee at chattanooga|chattanooga|community christian|southeast missouri|semo|calhoun|redhawks|warhawks)\b/i;
const OTHER_SPORT = /\b(?:baseball|softball|basketball|soccer|volleyball|lacrosse|golf|tennis)\b/i;
const offerClause = (text) => {
  const m = String(text || '').match(/\b(?:offer|offered|scholarship)\s+(?:to play\s+\w+\s+)?(?:from|by|at|with)\s+([^.!?\n]{1,180})/i);
  return m ? m[1] : String(text || '');
};
export function seedDisplayAffiliations(post, cache, observedAt = new Date().toISOString()) {
  cache.accounts ||= {};
  for (const m of post.mentioned || []) {
    const h = String(m.handle || '').toLowerCase(); if (!h || cache.accounts[h]) continue;
    const d = norm(m.name || '');
    const hits = SCHOOLS.filter((s) => d === norm(s.name) || d === norm(s.name + ' ' + s.nickname));
    if (hits.length === 1) cache.accounts[h] = { handle: h, displayName: m.name || null, affiliationType: 'program', fbsSchoolId: hits[0].id, source: 'tagged_display_name', confidence: 0.98, checkedAt: observedAt, expiresAt: new Date(new Date(observedAt).getTime() + 14 * 864e5).toISOString() };
  }
}
export function resolveOfferTarget(post, cache = { accounts: {} }) {
  const text = String(post.text || '');
  const clause = offerClause(text);
  if (OTHER_SPORT.test(clause)) return { status: 'rejected', reason: 'other_sport_target', evidence: {} };
  if (NON_FBS.test(clause)) return { status: 'rejected', reason: 'explicit_non_fbs_target', evidence: { targetText: clause.slice(0, 180) } };
  // Exact official handle in the offer clause is authoritative.
  const handles = [...clause.matchAll(/@([A-Za-z0-9_]{2,15})/g)].map((x) => x[1].toLowerCase());
  const official = [...new Set(handles.map((h) => HANDLES.get(h)).filter(Boolean))];
  if (official.length === 1) return { status: 'accepted', schoolId: official[0], reason: 'official_school_tag', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'official_school_tag', affiliationSource: 'fbs_handle' } };
  if (official.length > 1) return { status: 'pending', reason: 'conflicting_official_targets', evidence: { targetText: clause.slice(0, 180) } };
  // Full institution names are valid only in the offer clause (never trailing cheers).
  const hits = findSchools(clause).filter((x) => x.id && x.confidence >= .9);
  if (hits.length === 1) return { status: 'accepted', schoolId: hits[0].id, reason: 'full_school_name', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'full_school_name', affiliationSource: hits[0].method } };
  // A cached tagged coach/program affiliation may resolve a coach-only offer sentence.
  const linked = [...new Set(handles.map((h) => cache.accounts?.[h]).filter((a) => a && a.fbsSchoolId && a.expiresAt > new Date().toISOString() && /coach|program/.test(a.affiliationType || '')).map((a) => a.fbsSchoolId))];
  if (linked.length === 1) return { status: 'accepted', schoolId: linked[0], reason: 'coach_affiliation', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'coach_affiliation', affiliationSource: 'profile_cache' } };
  return { status: 'pending', reason: hits.length > 1 ? 'ambiguous_target' : 'unresolved_offer_target', evidence: { targetText: clause.slice(0, 180) } };
}

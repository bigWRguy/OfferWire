import { SCHOOLS, HANDLES, findSchools, foreignInstitution, explicitNonFbsOfferTarget, namePhrases, norm } from './schools.js';
import { decodeEntities } from '../lib/store.js';

const OTHER_SPORT = /\b(?:baseball|softball|basketball|soccer|volleyball|lacrosse|golf|tennis|wrestling|rowing|hockey)\b|\bflag\s+football\b|\b(?:women|womens|girls|ladies)(?:['’]s)?\s+(?:flag\s+)?(?:football|team|program)\b/i;

const OFFER_VERB = /\b(?:offers?|offered|offering)\b/i;
const OFFER_VERB_FALLBACK = /\b(?:scholarships?)\b/i;
const OBJECT_JOIN = /^\s*(?:to\s+play\s+\w+\s+)?(?:from|by|at|with)\s+|^\s*to\s+play\s+(?=@)/i;

export function offerSpan(text) {
  const src = decodeEntities(text || '');
  for (const sentence of src.split(/(?<=[.!?\n])/)) {
    const m = sentence.match(OFFER_VERB) || sentence.match(OFFER_VERB_FALLBACK);
    if (!m) continue;
    const after = sentence.slice(m.index + m[0].length);
    const join = after.match(OBJECT_JOIN);
    if (join) return { text: after.slice(join[0].length), form: 'object' };
    return { text: sentence.slice(0, m.index), form: 'subject' };
  }
  return { text: src, form: 'whole' };
}

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
  const text = decodeEntities(post.text || '');
  const span = offerSpan(text);
  const clause = span.text;
  if (OTHER_SPORT.test(clause)) return { status: 'rejected', reason: 'other_sport_target', evidence: {} };
  if (explicitNonFbsOfferTarget(text) || (span.form !== 'whole' && foreignInstitution(clause))) {
    return { status: 'rejected', reason: 'explicit_non_fbs_target', evidence: { targetText: clause.slice(0, 180) } };
  }
  const objectHandle = span.form === 'object' && clause.match(/^\s*@([A-Za-z0-9_]{2,15})/);
  if (objectHandle && !HANDLES.has(objectHandle[1].toLowerCase()) && /(?:football|fball|athletics|_fb|fb)$/i.test(objectHandle[1])) {
    return { status: 'rejected', reason: 'non_fbs_handle_target', evidence: { targetText: clause.slice(0, 180) } };
  }

  const taggedFbs = (post.mentioned || []).some((m) => HANDLES.has(String(m.handle || '').toLowerCase()))
    || [...text.matchAll(/@([A-Za-z0-9_]{2,15})/g)].some((x) => HANDLES.has(x[1].toLowerCase()));
  if (!taggedFbs) {
    const foreignTag = (post.mentioned || []).find((m) => {
      const name = String(m.name || '').replace(/\b(?:FB|Football|Athletics|Recruiting)\b/gi, ' ').trim();
      return name.split(/\s+/).length >= 2 && foreignInstitution(name);
    });
    if (foreignTag) return { status: 'rejected', reason: 'non_fbs_program_tagged', evidence: { targetText: String(foreignTag.name).slice(0, 180) } };
  }

  const handles = [...text.matchAll(/@([A-Za-z0-9_]{2,15})/g)].map((x) => x[1].toLowerCase());
  const official = [...new Set(handles.map((h) => HANDLES.get(h)).filter(Boolean))];
  if (official.length === 1) return { status: 'accepted', schoolId: official[0], reason: 'official_school_tag', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'official_school_tag', affiliationSource: 'fbs_handle' } };
  if (official.length > 1) return { status: 'pending', reason: 'conflicting_official_targets', evidence: { targetText: clause.slice(0, 180) } };
  const hits = findSchools(clause).filter((x) => x.id && x.confidence >= .9);
  if (hits.length === 1) return { status: 'accepted', schoolId: hits[0].id, reason: 'full_school_name', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'full_school_name', affiliationSource: hits[0].method } };
  const linked = [...new Set(handles.map((h) => cache.accounts?.[h]).filter((a) => a && a.fbsSchoolId && a.expiresAt > new Date().toISOString() && /coach|program/.test(a.affiliationType || '')).map((a) => a.fbsSchoolId))];
  if (linked.length === 1) return { status: 'accepted', schoolId: linked[0], reason: 'coach_affiliation', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'coach_affiliation', affiliationSource: 'profile_cache' } };
  if (hits.length > 1) return { status: 'pending', reason: 'ambiguous_target', evidence: { targetText: clause.slice(0, 180) } };
  if (span.form === 'object' && namePhrases(clause).some((p) => p.start <= 1)) {
    return { status: 'rejected', reason: 'explicit_non_fbs_target', evidence: { targetText: clause.slice(0, 180) } };
  }
  return { status: 'pending', reason: 'unresolved_offer_target', evidence: { targetText: clause.slice(0, 180) } };
}

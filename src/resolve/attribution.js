// Deterministic offer-target attribution. Contextual school mentions are never targets.
import { SCHOOLS, HANDLES, findSchools, foreignInstitution, explicitNonFbsOfferTarget, namePhrases, norm } from './schools.js';
import { decodeEntities } from '../lib/store.js';

const OTHER_SPORT = /\b(?:baseball|softball|basketball|soccer|volleyball|lacrosse|golf|tennis)\b/i;

// Every form the verb takes. The old pattern listed only "offer|offered|scholarship",
// so the extremely common PLURAL ("holds two FBS offers from Tulsa and Samford", "Offers
// from Oregon, Tennessee, Vanderbilt and others") matched nothing and fell through to
// the whole-post fallback below — which is how a hashtag (#RecruitGeorgia), a game
// preview ("the Iowa-Iowa State game") and other schools' offer lists were published as
// offers from those schools.
const OFFER_VERB = /\b(?:offers?|offered|offering)\b/i;
// Only consulted when the post never says "offer" at all — otherwise "my first SEC
// Division I scholarship offer from the University of Oklahoma" anchors on the word
// "scholarship" and reads the span backwards from the wrong word.
const OFFER_VERB_FALLBACK = /\b(?:scholarships?)\b/i;
// The target follows the verb directly: "offer from X", "offer to play football at X".
// Immediacy matters — in "has offered 2028 OT Roman Maurizio from Central Catholic HS"
// the "from" introduces the recruit's high school, not the program.
// "…an offer to play @nwc_fb" names its target directly after "to play", with no
// preposition at all. Without this the sentence read as subject form and the school the
// recruit merely VISITED ("After a great visit at Northwestern…") became the offerer.
const OBJECT_JOIN = /^\s*(?:to\s+play\s+\w+\s+)?(?:from|by|at|with)\s+|^\s*to\s+play\s+(?=@)/i;

/**
 * The span of text that can name the offering program, and nothing else.
 *
 *   object form   "...blessed to receive an offer FROM ALABAMA"   -> after the verb
 *   subject form  "WAKE FOREST HAS OFFERED 2028 OT ..."           -> before the verb
 *
 * Anything outside that span — a trailing cheer, a hashtag, a list of the recruit's
 * other offers, the high school he plays for — is context, not the target.
 */
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
  // No offer verb anywhere (emoji-spelled announcements, "🅾️ffer"). Nothing to narrow
  // to, so the post as a whole is the only evidence there is.
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
  // The post says outright that a non-FBS school is offering. This used to be a
  // hand-maintained regex of school names that had already burned us once each; it now
  // asks the resolver, which knows every US college that is not an FBS program.
  if (explicitNonFbsOfferTarget(text) || (span.form !== 'whole' && foreignInstitution(clause))) {
    return { status: 'rejected', reason: 'explicit_non_fbs_target', evidence: { targetText: clause.slice(0, 180) } };
  }
  // The offer object is a tagged PROGRAM account that is not one of the 136:
  // "an offer to play @nwc_fb" is Northwestern College (NAIA), not Northwestern.
  const objectHandle = span.form === 'object' && clause.match(/^\s*@([A-Za-z0-9_]{2,15})/);
  if (objectHandle && !HANDLES.has(objectHandle[1].toLowerCase()) && /(?:football|fball|athletics|_fb|fb)$/i.test(objectHandle[1])) {
    return { status: 'rejected', reason: 'non_fbs_handle_target', evidence: { targetText: clause.slice(0, 180) } };
  }

  // Exact official handle is authoritative, and is read from the WHOLE post: recruits
  // routinely tag the program after the sentence ends ("...my first offer!! @GamecockFB").
  const handles = [...text.matchAll(/@([A-Za-z0-9_]{2,15})/g)].map((x) => x[1].toLowerCase());
  const official = [...new Set(handles.map((h) => HANDLES.get(h)).filter(Boolean))];
  if (official.length === 1) return { status: 'accepted', schoolId: official[0], reason: 'official_school_tag', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'official_school_tag', affiliationSource: 'fbs_handle' } };
  if (official.length > 1) return { status: 'pending', reason: 'conflicting_official_targets', evidence: { targetText: clause.slice(0, 180) } };
  // Full institution names count only inside the offer span.
  const hits = findSchools(clause).filter((x) => x.id && x.confidence >= .9);
  if (hits.length === 1) return { status: 'accepted', schoolId: hits[0].id, reason: 'full_school_name', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'full_school_name', affiliationSource: hits[0].method } };
  const linked = [...new Set(handles.map((h) => cache.accounts?.[h]).filter((a) => a && a.fbsSchoolId && a.expiresAt > new Date().toISOString() && /coach|program/.test(a.affiliationType || '')).map((a) => a.fbsSchoolId))];
  if (linked.length === 1) return { status: 'accepted', schoolId: linked[0], reason: 'coach_affiliation', evidence: { targetText: clause.slice(0, 180), schoolEvidenceType: 'coach_affiliation', affiliationSource: 'profile_cache' } };
  if (hits.length > 1) return { status: 'pending', reason: 'ambiguous_target', evidence: { targetText: clause.slice(0, 180) } };
  // The post states its offerer outright ("offer from SEMO Redhawks", "offer from
  // Chattanooga") and it is not one of the 136. That is a decided non-FBS offer, not
  // something to hold for review — "pending" would leave it queued forever.
  if (span.form === 'object' && namePhrases(clause).some((p) => p.start <= 1)) {
    return { status: 'rejected', reason: 'explicit_non_fbs_target', evidence: { targetText: clause.slice(0, 180) } };
  }
  return { status: 'pending', reason: 'unresolved_offer_target', evidence: { targetText: clause.slice(0, 180) } };
}

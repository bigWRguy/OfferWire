// School entity resolution. The whole point: an offer post almost never spells the
// school out the way a database would. It says "@GamecockFB", "the U", "#GoDawgs",
// "Miss State", or just a helmet emoji next to a coach's name. We normalise all of it.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../lib/store.js';

export const norm = (s) => (s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

function loadTsv() {
  const raw = fs.readFileSync(path.join(CONFIG, 'fbs.tsv'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => {
    const [id, name, nickname, handle, conf, extra] = line.split('\t');
    return {
      id, name, nickname, handle, conference: conf,
      aliases: (extra || '').split(';').map((s) => s.trim()).filter(Boolean),
    };
  });
}

export const SCHOOLS = loadTsv();
export const byId = new Map(SCHOOLS.map((s) => [s.id, s]));

// Surface forms that are too generic to match on their own. "Tigers" is 4 schools,
// "USC" is two, "Miami" is two. These only resolve with a disambiguating co-token.
const AMBIGUOUS = {
  tigers: ['lsu', 'auburn', 'clemson', 'missouri', 'memphis'],
  bulldogs: ['georgia', 'mississippi-state', 'fresno-state', 'louisiana-tech'],
  wildcats: ['kentucky', 'kansas-state', 'arizona', 'northwestern'],
  cougars: ['byu', 'houston', 'washington-state'],
  huskies: ['washington', 'uconn', 'northern-illinois'],
  aggies: ['texas-am', 'utah-state', 'new-mexico-state'],
  cardinals: ['louisville', 'ball-state'],
  spartans: ['michigan-state', 'san-jose-state'],
  panthers: ['pittsburgh', 'florida-international', 'georgia-state'],
  eagles: ['boston-college', 'georgia-southern', 'eastern-michigan'],
  owls: ['temple', 'rice', 'florida-atlantic', 'kennesaw-state'],
  rebels: ['ole-miss', 'unlv'],
  falcons: ['air-force', 'bowling-green'],
  broncos: ['boise-state', 'western-michigan'],
  cowboys: ['oklahoma-state', 'wyoming'],
  rams: ['colorado-state'],
  usc: ['usc', 'south-carolina'],
  osu: ['ohio-state', 'oklahoma-state', 'oregon-state'],
  msu: ['michigan-state', 'mississippi-state', 'missouri-state'],
  uw: ['washington', 'wisconsin', 'wyoming'],
  miami: ['miami', 'miami-oh'],
  ul: ['louisiana', 'louisiana-monroe'],
  ku: ['kansas'],
  nu: ['nebraska', 'northwestern'],
  ua: ['alabama', 'arizona'],
  um: ['michigan', 'miami'],
  cu: ['clemson', 'colorado'],
  tu: ['temple', 'tulsa'],
  ut: ['tennessee', 'texas'],
  ou: ['oklahoma', 'ohio'],
};

// Build the lookup: exact-form -> [schoolIds]
const forms = new Map();
const add = (form, id) => {
  const k = norm(form);
  if (!k || k.length < 2) return;
  if (!forms.has(k)) forms.set(k, new Set());
  forms.get(k).add(id);
};
for (const s of SCHOOLS) {
  add(s.name, s.id);
  add(`${s.name} ${s.nickname}`, s.id);
  add(s.handle, s.id);
  s.aliases.forEach((a) => add(a, s.id));
  // "University of X" / "X University" / "X State"
  add(`university of ${s.name}`, s.id);
  add(`${s.name} university`, s.id);
  // nickname only, but routed through the ambiguity gate below
  add(s.nickname, s.id);
}
for (const [form, ids] of Object.entries(AMBIGUOUS)) {
  if (!forms.has(form)) forms.set(form, new Set());
  ids.forEach((i) => forms.get(form).add(i));
}

export const HANDLES = new Map(SCHOOLS.map((s) => [s.handle.toLowerCase(), s.id]));

// Longest-form-first so "michigan state" beats "michigan".
const FORM_LIST = [...forms.keys()].sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Institution-name boundaries  (the core precision rule)
// ---------------------------------------------------------------------------
// There are ~2,400 colleges in the United States and 136 of them play FBS football.
// Most of the wire's worst errors were the same mistake: matching an FBS name INSIDE
// the name of one of the other 2,264. "The Colorado School of Mines" became Colorado.
// "Alabama State University" became Alabama. "Wisconsin Lutheran College" became
// Wisconsin. Each one used to get its own hand-written regex, which is a losing game.
//
// Two general layers replace that pile, in this order:
//
//   1. ROSTER — config/non-fbs.txt lists every US institution that is not an FBS
//      program (built by scripts/build-non-fbs.mjs). If a name phrase in the post
//      contains one of them, the phrase is about that school, full stop.
//   2. SHAPE — for names the roster has never heard of, one rule: a school surface
//      only counts when the WHOLE institution name it sits inside is that school's
//      name. Anything else in the phrase that names a different institution
//      ("... School of Mines", "... State University", "Northern ...") disqualifies it.
//
// The shape rule is symmetric, which also fixes the opposite bug: the old
// directional-prefix regexes DELETED five real programs, so Western Michigan, Central
// Michigan, Eastern Michigan, Western Kentucky and Northern Illinois could never be
// resolved by name at all.

// Words that make a phrase institution-shaped. "State" and "Tech" are here because
// "Alabama State" / "Wentworth Tech" need no "University" to be a different school.
const INSTITUTION_WORD = new Set(['university', 'universities', 'college', 'colleges', 'school', 'schools',
  'institute', 'institutes', 'academy', 'academies', 'seminary', 'conservatory', 'polytechnic',
  'community', 'junior', 'state', 'tech', 'technical', 'technological', 'prep', 'preparatory', 'cc', 'jc']);

// Words that may trail a school's name WITHOUT naming a different school.
const GENERIC_TAIL = new Set(['university', 'univ', 'the', 'of', 'at', 'football', 'fb', 'athletics',
  'athletic', 'program', 'staff', 'recruiting', 'sports', 'mens', 'womens', 'men', 'women',
  'department', 'edu', 'u']);

// Words that, sitting directly in front of a school's name, make it a different school
// ("Northern Colorado", "Southeastern Louisiana"). Closed set on purpose: an arbitrary
// preceding word is usually a coach's name ("Coach Wilson Colorado State") and must not
// disqualify the school behind it. FBS names that legitimately start this way - North
// Texas, Western Michigan, Southern Miss - are matched at full length first, so the
// qualifier is inside the matched form and never reaches this test.
const QUALIFIER_PREFIX = new Set(['north', 'south', 'east', 'west', 'central', 'northern', 'southern',
  'eastern', 'western', 'northeastern', 'northwestern', 'southeastern', 'southwestern',
  'northwest', 'northeast', 'southwest', 'southeast', 'upper', 'lower', 'greater', 'saint', 'st',
  'mount', 'mt']);

// The mirror image of QUALIFIER_PREFIX: a word from this closed class directly AFTER a
// school's name is part of a different school's name, with or without a trailing
// "College" — "Arizona Christian", "Kansas Christian", "West Virginia Wesleyan",
// "Concordia Lutheran". FBS names that contain one ("Texas Christian") match at full
// length first and never reach this test.
const MODIFIER_SUFFIX = new Set(['christian', 'baptist', 'lutheran', 'wesleyan', 'methodist',
  'catholic', 'adventist', 'bible', 'biblical', 'mennonite', 'nazarene', 'brethren',
  'evangelical', 'theological', 'presbyterian', 'episcopal', 'hebrew', 'islamic',
  'military', 'maritime', 'valley', 'highlands']);

// A campus join: what follows is a different campus, not the flagship.
// "University of Alabama at Birmingham", "Indiana University of Pennsylvania".
const BRANCH_JOIN = new Set(['at', 'in', 'of']);

// Lowercase words allowed to sit INSIDE a name phrase. "and" is deliberately absent:
// "Coach Smith and Colorado State" must be two phrases, not one.
const CONNECTOR = new Set(['of', 'at', 'the']);

// Institutional tails a post routinely omits: "Kansas Wesleyan University" is written
// "Kansas Wesleyan", "East Mississippi Community College" is "East Mississippi".
const TRIMMABLE_TAIL = new Set(['university', 'college', 'colleges', 'institute', 'academy',
  'seminary', 'community', 'junior', 'the', 'of', 'at', 'and']);

// ---- the non-FBS roster -----------------------------------------------------------
// Loaded once. Absent file is tolerated (the shape rule still runs) so the resolver
// never hard-fails on a fresh checkout before scripts/build-non-fbs.mjs has run.
const NON_FBS = new Map();
let NON_FBS_MAX = 0;
try {
  const txt = fs.readFileSync(path.join(CONFIG, 'non-fbs.txt'), 'utf8');
  for (const line of txt.split('\n')) {
    const name = line.trim();
    if (!name || name.startsWith('#')) continue;
    const n = norm(name);
    // Posts drop the institutional tail: "Kansas Wesleyan!", "West Virginia Wesleyan",
    // "East Mississippi", "Florida Southern". Index the shortened forms too, but never
    // one that is itself an FBS surface.
    const variants = [n];
    const t = n.split(' ');
    while (t.length > 2 && TRIMMABLE_TAIL.has(t[t.length - 1])) {
      t.pop();
      const v = t.join(' ');
      if (!forms.has(v) && !isFbsInstitutionName(v)) variants.push(v);
    }
    for (const v of variants) {
      const len = v.split(' ').length;
      if (len < 2) continue;
      if (!NON_FBS.has(v)) NON_FBS.set(v, name);
      if (len > NON_FBS_MAX) NON_FBS_MAX = len;
    }
  }
} catch { /* roster not built yet */ }

export const nonFbsRosterSize = () => NON_FBS.size;

/** Longest contiguous roster (non-FBS) school name inside a normalised token list. */
function longestNonFbsSpan(tokens) {
  for (let len = Math.min(tokens.length, NON_FBS_MAX); len >= 2; len--) {
    for (let s = 0; s + len <= tokens.length; s++) {
      const hit = NON_FBS.get(tokens.slice(s, s + len).join(' '));
      if (hit) return { name: hit, s, e: s + len };
    }
  }
  return null;
}

/** Maximal capitalised name phrases in raw text, with their character spans. */
export function namePhrases(raw) {
  const src = String(raw || '');
  const toks = [];
  for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9&'’.]*(?:[-–][A-Za-z0-9&'’.]+)*/g)) {
    toks.push({ t: m[0], i: m.index, e: m.index + m[0].length });
  }
  const out = [];
  let cur = [];
  const flush = () => {
    while (cur.length && CONNECTOR.has(cur[cur.length - 1].t.toLowerCase())) cur.pop();
    if (cur.length) out.push({ start: cur[0].i, end: cur[cur.length - 1].e, text: src.slice(cur[0].i, cur[cur.length - 1].e) });
    cur = [];
  };
  for (let k = 0; k < toks.length; k++) {
    // Only plain spaces join a phrase. A comma, a line break, an emoji or any other
    // punctuation ends it, so "Thank you Coach Smith, Colorado State" is two phrases.
    const joined = k > 0 && /^[ \t]*(?:[-–—][ \t]*)?$/.test(src.slice(toks[k - 1].e, toks[k].i));
    if (!joined) flush();
    const t = toks[k].t;
    if (/^[A-Z]/.test(t)) cur.push(toks[k]);
    else if (cur.length && CONNECTOR.has(t.toLowerCase())) cur.push(toks[k]);
    else flush();
  }
  flush();
  return out;
}

/** Longest contiguous FBS surface form inside a normalised token list. */
function longestFormSpan(tokens) {
  for (let len = Math.min(tokens.length, 7); len >= 1; len--) {
    for (let s = 0; s + len <= tokens.length; s++) {
      const f = tokens.slice(s, s + len).join(' ');
      if (forms.has(f)) return { s, e: s + len, form: f };
    }
  }
  return null;
}

/**
 * The shape rule: given the FBS surface found inside a name phrase, does the REST of
 * the phrase name a different institution? Roster-independent, so the roster builder
 * can use it to decide which downloaded names are the FBS school itself.
 */
function foreignByShape(tokens, best, dashStarts = new Set()) {
  // In front of the name: a regional qualifier, or an institution head ("College of X",
  // "School of X"). "University of X" is the FBS school itself, so it is excluded.
  const before = tokens[best.s - 1];
  if (before && QUALIFIER_PREFIX.has(before)) return 'qualifier';
  if (before === 'of' && best.s >= 2 && INSTITUTION_WORD.has(tokens[best.s - 2]) && tokens[best.s - 2] !== 'university') {
    return 'head';
  }

  const after = tokens.slice(best.e);
  if (!after.length) return null;
  if (MODIFIER_SUFFIX.has(after[0])) return 'modifier';
  // Everything up to the LAST institution word after the name is part of the name.
  // Anything non-generic in there is a different school: "[Colorado] School of Mines",
  // "[Alabama] State University", "[Cal] State Northridge", "[Wisconsin] Lutheran
  // College". Tokens past that word are ordinary prose and are ignored, so "Colorado
  // State Thank You Coach" survives.
  let lastKw = -1;
  after.forEach((t, i) => { if (INSTITUTION_WORD.has(t)) lastKw = i; });
  if (lastKw >= 0) return after.slice(0, lastKw + 1).some((t) => !GENERIC_TAIL.has(t)) ? 'suffix' : null;
  // No institution word after the name. Only a campus join or a regional qualifier
  // changes identity ("University of Alabama at Birmingham", "Purdue University
  // Northwest"); a bare trailing word does not, so "University of Colorado Boulder"
  // and "Michigan State Spartans Football" survive.
  if (BRANCH_JOIN.has(after[0]) && after.some((t) => !GENERIC_TAIL.has(t))) return 'branch';
  if (QUALIFIER_PREFIX.has(after[0])) return 'branch';
  // A dash right after the name is a campus join too ("University of Alabama -
  // Huntsville"). It only counts when the school's own name did not already span the
  // dash, which is why this reads the token index rather than rewriting the text:
  // "Louisiana-Monroe", "Texas-San Antonio" and "Alabama-Birmingham" ARE the programs.
  if (dashStarts.has(best.e) && after.some((t) => !GENERIC_TAIL.has(t))) return 'branch';
  return null;
}

/** Normalised tokens for a phrase, plus the indexes that start a post-dash segment. */
function tokenizePhrase(phrase) {
  const tokens = [];
  const dashStarts = new Set();
  const segs = String(phrase || '').split(/\s*[-–—]\s*/);
  segs.forEach((seg, i) => {
    const t = norm(seg).split(' ').filter(Boolean);
    if (i > 0 && t.length) dashStarts.add(tokens.length);
    tokens.push(...t);
  });
  return { tokens, dashStarts };
}

/**
 * Does this name phrase name an institution OTHER than the FBS school inside it?
 * @returns {null|{name:string, why:string}} null = phrase is (or contains no) FBS school
 */
export function foreignInstitution(phrase) {
  const { tokens, dashStarts } = tokenizePhrase(phrase);
  const best = longestFormSpan(tokens);
  const known = longestNonFbsSpan(tokens);
  // Both rosters can hit the same words ("Middle Tennessee State" is an FBS program and
  // contains the non-FBS "Tennessee State"). The longer name is the one being written.
  if (known && (!best || known.e - known.s > best.e - best.s)) return { name: known.name, why: 'roster' };
  if (!best) return null;
  const why = foreignByShape(tokens, best, dashStarts);
  return why ? { name: best.form, why } : null;
}

/**
 * Is this full institution name an FBS program? Used by scripts/build-non-fbs.mjs to
 * keep FBS schools (Miami University, Ohio University, University of Colorado) off the
 * non-FBS roster — the roster must never be able to blank out a real program.
 */
export function isFbsInstitutionName(name) {
  const tokens = norm(name).split(' ').filter(Boolean);
  const best = longestFormSpan(tokens);
  if (!best) return false;
  // The name is the FBS school only if it is the school's own name and nothing else:
  // "Miami University", "University of Colorado". Any extra naming token means a
  // different institution ("Arkansas State University Mid-South", "University of
  // Alabama in Huntsville"), which belongs on the non-FBS roster.
  return [...tokens.slice(0, best.s), ...tokens.slice(best.e)].every((t) => GENERIC_TAIL.has(t));
}

/** Blank out every name phrase that names a non-FBS institution. */
function stripForeignInstitutions(raw) {
  let out = String(raw || '');
  for (const p of namePhrases(out)) {
    if (foreignInstitution(p.text)) out = out.slice(0, p.start) + ' '.repeat(p.end - p.start) + out.slice(p.end);
  }
  return out;
}

// Surfaces that are ordinary English words as often as they are schools ("Tech",
// "Rice", "Army", "Liberty", "the U"). They still resolve - the LLM pass reads the
// context we cannot - but they never carry the high confidence the rules-only path is
// allowed to act on by itself.
// Kept to clipped nicknames and abbreviations. A school's actual NAME stays at full
// confidence even when it is also a common word ("Liberty", "Rice", "Army"): by the
// time this runs the post has already been classified as offer language, where the
// name reading is the right one.
const WEAK_SURFACE = new Set(['tech', 'wake', 'app', 'coastal', 'kent', 'cards', 'irish',
  'rockets', 'the u', 'cuse', 'cards', 'hogs', 'horns']);

// "Dorman HS, SC" and "ABC Prep (NM)" are hometowns. A two-letter postal code after a
// comma or in parentheses is a location, never a program - that read "SC" as South
// Carolina and "UT"/"IN"/"OK" as programs on genuinely unrelated posts.
const POSTAL_CODE = /(,\s*|\(\s*)(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/g;

// A tagged program account that is NOT one of the 136 is direct evidence about who is
// offering: "@MinesFootball", "@GVSUFootball". When one of those is in the post and no
// FBS account is tagged at all, a name-only match is corroborated by nothing and must
// not reach the confidence the rules-only path acts on.
// It must be the OFFER TARGET, not just any tagged account: half the recruiting world
// (7v7 teams, scouting services, coaches) has a handle ending in FB, so "a non-FBS
// football handle appears somewhere in the post" says nothing at all.
const OFFER_TARGET_HANDLE = /\b(?:offer|offered|offers|scholarship)\s+(?:from|by)\s+@([A-Za-z0-9_]{2,15})/gi;
function taggedForeignProgram(raw) {
  let foreign = false;
  for (const m of String(raw || '').matchAll(OFFER_TARGET_HANDLE)) {
    if (HANDLES.has(m[1].toLowerCase())) return false; // an FBS program is the target
    foreign = true;
  }
  return foreign;
}

/**
 * Find every FBS school referenced in a blob of text.
 * @param {string} text raw post text (mentions/hashtags included)
 * @returns {Array<{id,surface,method,confidence}>}
 */
export function findSchools(text) {
  const hits = new Map();
  const raw = text || '';

  // 1. @handles are the strongest signal there is — exact and unambiguous.
  for (const m of raw.matchAll(/@([A-Za-z0-9_]{2,15})/g)) {
    const id = HANDLES.get(m[1].toLowerCase());
    if (id) hits.set(id, { id, surface: '@' + m[1], method: 'handle', confidence: 0.99 });
  }

  // 2. Text forms, hashtags flattened (#GoBlue -> go blue, #RollTide -> roll tide)
  //
  // Longest form first, and each match CONSUMES its span. Without consumption
  // "Michigan State" also matches the shorter form "Michigan" and the post gets
  // attributed to two schools, one of which never offered anybody.
  //
  // Two classes of text are removed first, because neither is a program:
  //   a) institution names that are not this FBS school (see foreignInstitution),
  //   b) hometowns - half the FBS is named after a state, so
  //      "out of ... Leesburg, Virginia" would otherwise file a Virginia offer.
  // Handle matches are unaffected - that pass already ran and is exact.
  const STATE_NAMES = new RegExp("(,\\s*|\\bin\\s+|\\bout\\s+of\\s+[^,]{0,40},\\s*)(?:(?:North|Northern|South|Southern|East|Eastern|West|Western|Central)\\s+)?(Alabama|Arizona|Arkansas|California|Colorado|Connecticut|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|New Mexico|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|South Carolina|Tennessee|Texas|Utah|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\\b(?!\\s*(?:State|Tech|A&M|Football|offer))", 'gi');
  // A school-named CITY immediately followed by a state is a hometown too:
  //   "a kid out of Houston, Texas" names neither Houston nor Texas as a program.
  // The same names are REGIONS as often as they are programs: "in South Florida", 
  // "North Texas universities offer free tuition", "Southern California weather".
  // Built from the same state list, with the directional prefixes the programs use, so
  // it stays one rule rather than one regex per school.
  const REGION_USE = new RegExp("(?:(?:North|Northern|South|Southern|East|Eastern|West|Western|Central)\\s+)?(Alabama|Arizona|Arkansas|California|Colorado|Connecticut|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|New Mexico|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|South Carolina|Tennessee|Texas|Utah|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\\s+(?:area|areas|region|regions|universities|colleges|schools|residents|natives?|weather|county|counties|cities)\\b", "gi");
  const CITY_THEN_STATE = new RegExp("\\b(Houston|Miami|Buffalo|Cincinnati|Memphis|Charlotte|Toledo|Akron|Tulsa|Auburn|Boise|Fresno|Reno|Baylor|Rice|Temple|Troy|Duke|Rutgers|Syracuse)\\s*,\\s*(?:Alabama|Arizona|Arkansas|California|Colorado|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|New York|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|South Carolina|Tennessee|Texas|Utah|Virginia|Washington|Wisconsin|[A-Z]{2}\\b)", 'gi');
  const deSchooled = stripForeignInstitutions(raw);
  // A postal code is a location, EXCEPT where the school's own name carries it:
  // "Miami (OH)" is a program, "Dorman HS, SC" is a hometown.
  const deLocated = deSchooled.replace(POSTAL_CODE, (m, pre, code, offset, str) => {
    const prev = (str.slice(Math.max(0, offset - 30), offset).match(/([A-Za-z]+)[^A-Za-z]*$/) || [])[1];
    return prev && forms.has(norm(`${prev} ${code}`)) ? m : pre;
  }).replace(REGION_USE, ' ').replace(CITY_THEN_STATE, ' ').replace(STATE_NAMES, (m, pre) => pre + ' ');

  let hay = ' ' + norm(deLocated.replace(/#([A-Za-z]+)/g, (_, w) => ' ' + w.replace(/([a-z])([A-Z])/g, '$1 $2') + ' ')) + ' ';
  const consume = (form) => { hay = hay.split(' ' + form + ' ').join('     '); };
  // Corroboration available in the post itself, applied to every name-only match.
  const unbacked = taggedForeignProgram(raw);
  const nameConfidence = (form) => {
    if (form.length <= 6 || WEAK_SURFACE.has(form)) return 0.8;
    return unbacked ? 0.85 : 0.92;
  };

  for (const form of FORM_LIST) {
    if (!hay.includes(' ' + form + ' ')) continue;
    const ids = [...forms.get(form)];

    if (ids.length === 1) {
      const id = ids[0];
      consume(form);
      if (!hits.has(id)) {
        hits.set(id, { id, surface: form, method: 'name', confidence: nameConfidence(form) });
      }
      continue;
    }

    // Ambiguous surface ("USC", "Miami", "Tigers"). Resolve it only on evidence that
    // is INDEPENDENT of the ambiguous token itself.
    if (ids.some((i) => hits.has(i))) { consume(form); continue; } // already pinned by a handle

    // A candidate whose own name IS this token proves nothing — "USC" appearing in the
    // text does not distinguish USC from South Carolina. Only a candidate named
    // somewhere else in the post counts.
    const alt = ids.filter((i) => {
      const full = norm(byId.get(i).name);
      if (full === form) return false;
      return hay.includes(' ' + full + ' ');
    });

    consume(form);
    if (alt.length === 1) {
      hits.set(alt[0], { id: alt[0], surface: form, method: 'name+context', confidence: 0.85 });
    } else {
      // Unresolved. Recorded with id:null so the post still reaches the LLM pass, which
      // can read the coach names and regional context we cannot.
      hits.set('?' + form, { id: null, surface: form, candidates: ids, method: 'ambiguous', confidence: 0.4 });
    }
  }
  return [...hits.values()];
}

/**
 * Does the phrase contain any FBS school surface (whole-word)? Uses the SAME form map
 * that findSchools resolves against, but WITHOUT the location/prefix stripping that
 * would hide real FBS names ("Western Kentucky University", "Northern Illinois
 * University" get direction-prefix-stripped as if they were FCS schools). Whole-word
 * so a short alias like "UTA" cannot match inside "Utah".
 */
function containsFbsName(phrase) {
  const n = norm(phrase);
  if (!n) return false;
  const joined = ' ' + n + ' ';
  return FORM_LIST.some((f) => joined.includes(' ' + f + ' '));
}

/**
 * Does the post name a NON-FBS institution as the offer source?
 *
 * Live failures this exists for:
 *   "Blessed to receive an offer from Community Christian College! ... Go cyclones!"
 *   — a small-college offer, filed as a fabricated Iowa State P4 row because of the
 *   trailing cheer.
 *   "I'm beyond blessed to receive a scholarship offer from The Colorado School of
 *   Mines! @MinesFootball" — filed as a Colorado P4 offer.
 *
 * The rule reads the institution named DIRECTLY after the offer verb and asks the same
 * question the resolver asks: is that whole name an FBS program? A college mentioned
 * anywhere else in the post does not veto a real FBS offer.
 */
export function explicitNonFbsOfferTarget(text) {
  const src = String(text || '');
  // An FBS program account in the post outranks anything read out of prose: the handle
  // is exact, and a misspelled name is not evidence against it ("OFFER FROM EASTERN
  // CAROLINA UNIVERSITY!! @ECUPiratesFB" is an East Carolina offer, typo and all).
  for (const h of src.matchAll(/@([A-Za-z0-9_]{2,15})/g)) if (HANDLES.has(h[1].toLowerCase())) return false;
  const m = src.match(/\b(?:offer|offered|offers|scholarship)\s+(?:to\s+play\s+\w+\s+)?(?:from|by)\s+(?:the\s+)?/i);
  if (!m) return false;
  const at = m.index + m[0].length;
  // The name phrase must START at the offer verb's object; a phrase found later in the
  // post is some other school being talked about.
  const rest = src.slice(at);
  const phrase = namePhrases(rest).find((p) => p.start === 0);
  if (!phrase) return false;
  const tokens = norm(phrase.text).split(' ').filter(Boolean);
  // "offer from Alabama" / "offer from Coach Smith" — not an institution-shaped name,
  // so there is nothing here to contradict normal resolution.
  if (!tokens.some((t) => INSTITUTION_WORD.has(t))) return false;
  // Names a different institution than the FBS school inside it ("Colorado School of
  // Mines"), or is institution-shaped with no FBS school in it at all ("Harvard
  // University", "Santa Monica College").
  return !!foreignInstitution(phrase.text) || !containsFbsName(phrase.text);
}

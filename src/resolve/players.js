// Player identity. The hard part of an offer wire is not finding offer posts — it is
// deciding that "Jayden Thomas", "Jaydon Thomas", "J. Thomas" and "@jaydenthomas27"
// are or are not the same kid, without ever merging two different kids.
//
// Policy: merge only on positive evidence, never on name alone. A name-only join at
// this volume produces mass false positives (there are three Marcus Johnsons in every
// class). Every merge needs the name PLUS one corroborating field, and any hard
// conflict blocks the merge outright.
import { norm } from './schools.js';
import { maskAwardYears } from '../extract/rules.js';

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;

/** Nicknames that show up interchangeably in recruiting posts. */
const NICK = new Map(Object.entries({
  mike: 'michael', mikey: 'michael', chris: 'christopher', nick: 'nicholas',
  matt: 'matthew', tony: 'anthony', tj: 'tj', cj: 'cj', dj: 'dj', aj: 'aj',
  will: 'william', bill: 'william', billy: 'william', rob: 'robert', bob: 'robert',
  bobby: 'robert', jim: 'james', jimmy: 'james', joe: 'joseph', joey: 'joseph',
  dan: 'daniel', danny: 'daniel', dave: 'david', ben: 'benjamin', sam: 'samuel',
  alex: 'alexander', zach: 'zachary', zack: 'zachary', josh: 'joshua',
  nate: 'nathaniel', tom: 'thomas', tommy: 'thomas', steve: 'stephen', ty: 'tyler',
  jon: 'jonathan', johnny: 'john', jack: 'john', greg: 'gregory', andy: 'andrew',
  drew: 'andrew', tre: 'tre', trey: 'trey', deuce: 'deuce',
}));

export function nameKey(raw) {
  let n = norm(raw).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
  const parts = n.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const first = NICK.get(parts[0]) || parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last}`;
}

/** Cheap phonetic fold so Jayden/Jaiden/Jaeden collapse. Not Soundex — tuned for the
 *  vowel-spelling churn that dominates modern recruit names. */
export function fuzzyKey(raw) {
  const k = nameKey(raw);
  if (!k) return null;
  return k
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw')
    // 'y' has to fold with the vowels or Jayden/Jaiden/Jaeden stay three different
    // people, which is the single most common spelling split in modern recruit names.
    .replace(/[aeiouy]+/g, 'a')
    .replace(/(.)\1+/g, '$1');
}

const conflict = (a, b) => a != null && b != null && a !== b;

/**
 * Can these two player records be the same person?
 * @returns {{merge:boolean, why:string, score:number}}
 */
export function canMerge(a, b) {
  const ka = nameKey(a.name), kb = nameKey(b.name);
  if (!ka || !kb) return { merge: false, why: 'unparseable name', score: 0 };

  const exact = ka === kb;
  const fuzzy = fuzzyKey(a.name) === fuzzyKey(b.name);
  if (!exact && !fuzzy) return { merge: false, why: 'different name', score: 0 };

  // Hard blocks. Any of these means "different kid", full stop.
  if (conflict(a.classYear, b.classYear)) return { merge: false, why: 'class year conflict', score: 0 };
  if (conflict(a.handle, b.handle)) return { merge: false, why: 'different X handle', score: 0 };
  if (conflict(a.highSchool && norm(a.highSchool), b.highSchool && norm(b.highSchool))) {
    return { merge: false, why: 'high school conflict', score: 0 };
  }
  if (conflict(a.state, b.state)) return { merge: false, why: 'state conflict', score: 0 };

  // Positive corroboration. Name alone is never enough.
  let score = 0; const why = [];
  if (a.handle && a.handle === b.handle) { score += 1.0; why.push('handle'); }
  if (a.highSchool && b.highSchool && norm(a.highSchool) === norm(b.highSchool)) { score += 0.6; why.push('high school'); }
  if (a.classYear && a.classYear === b.classYear) { score += 0.35; why.push('class'); }
  if (a.state && a.state === b.state) { score += 0.25; why.push('state'); }
  if (a.position && b.position && a.position === b.position) { score += 0.2; why.push('position'); }
  if (exact) score += 0.15;

  return { merge: score >= 0.5, why: why.join('+') || 'name only', score };
}

export function mergeInto(target, incoming) {
  for (const f of ['classYear', 'position', 'highSchool', 'state', 'handle', 'height', 'weight', 'stars', 'gpa', 'forty', 'bio']) {
    if (target[f] == null && incoming[f] != null) target[f] = incoming[f];
  }
  // Name is backfilled but never overwritten. A player first seen through their own
  // handle ("blessed to receive...") has no name until a reporter post supplies one —
  // without this they stay nameless forever and never join with their own coverage.
  if (!target.name && incoming.name) target.name = incoming.name;
  const aliases = new Set([...(target.aliases || []), target.name, incoming.name].filter(Boolean));
  target.aliases = [...aliases];
  return target;
}

/** Find the one existing player this record belongs to, or null. Ambiguity (two
 *  equally-good candidates) resolves to null — we create a new record rather than
 *  guess, and flag it for review. Wrong merges are unrecoverable; duplicates are not. */
export function resolve(index, rec) {
  const fk = fuzzyKey(rec.name);
  if (!fk) return { player: null, ambiguous: false };
  const bucket = index.get(fk) || [];
  const scored = bucket.map((p) => ({ p, ...canMerge(p, rec) })).filter((x) => x.merge)
    .sort((x, y) => y.score - x.score);
  if (!scored.length) return { player: null, ambiguous: false };
  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.2) {
    return { player: null, ambiguous: true, candidates: scored.slice(0, 3).map((x) => x.p.id) };
  }
  return { player: scored[0].p, ambiguous: false, why: scored[0].why };
}

export function indexPlayers(players) {
  const idx = new Map();
  for (const p of players) {
    const fk = fuzzyKey(p.name);
    if (!fk) continue;
    if (!idx.has(fk)) idx.set(fk, []);
    idx.get(fk).push(p);
  }
  return idx;
}

/**
 * Recruit bios are the densest metadata on X. A self-announced offer post carries the
 * author's bio, and recruits format it almost identically:
 *   "C/O 28 Cache HS ||#7|| 6'2 180|| No 1 Wr Oklahoma || 4.35 40"
 *   "2027 Early Grad| 3⭐️|4.2 GPA| 4.8 40 | Colquitt Co GA| #18"
 * Class, position, size, school, state, stars, GPA and 40 time — free, from the same
 * request that found the offer. Everything here is conservative: a field is only
 * returned when the pattern is unambiguous.
 */
export function parseBio(bio, nowYear = new Date().getUTCFullYear()) {
  if (!bio) return {};
  const out = {};
  const t = ' ' + bio.replace(/\s+/g, ' ') + ' ';
  // Award/season years ("All State '25", "2025 1st Team All District") date an honor,
  // not the recruit. Class extraction runs on a copy with them removed so "'25" can
  // never outrank the actual class ("San Ramon Valley 2028 … Soph All State '25" filed
  // a 2028 recruit as class of 2025 before this mask existed). maskAwardYears is shared
  // with findClassYear() so post text and bios behave identically.
  const ct = ' ' + maskAwardYears(t) + ' ';

  // Class: "2028", "C/O 28", "c/o 2028", "'28", "HS 28"
  const explicitFull = ct.match(/\b(?:class\s+of|c\/?o|class|co)\s*['\u2018\u2019]?\s*(20(?:2[5-9]|3[0-5]))\b/i);
  const full = [...ct.matchAll(/\b(20(?:2[5-9]|3[0-5]))\b/g)].map((m) => +m[1])
    .filter((y) => y >= nowYear - 1 && y <= nowYear + 7);
  const short = ct.match(/\bc\/?o\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    || ct.match(/\bclass of\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    || ct.match(/\bc\/(?:o\/)?\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    // Bare "class" + two digits, no "of": "Class 28" is the same signal as "C/O 28",
    // and it only parses when written with a 4-digit year otherwise.
    || ct.match(/\bclass\s*['\u2018\u2019\u201C\u201D]?\s*(\d{2})\b/i)
    // School-suffix shorthand, the most common bio form of all: "Marysville HS 28",
    // "Milton HS l 29 OL", "University HS *28". "#" is excluded so a jersey number
    // after the school name is never read as a class.
    || ct.match(/\b(?:HS|High School|H\.S\.|High)\b[^0-9#]{0,8}(?:20)?(\d{2})\b/i)
    || ct.match(/(?:^|[\s|/])(\d{2})\s*['\u2018\u2019\u201C\u201D](?=$|[\s|/])/)
    || ct.match(/(?<!\d)['\u2018\u2019\u201C\u201D](\d{2})\b/);
  const shortYear = short ? 2000 + +short[1] : null;
  if (explicitFull) out.classYear = +explicitFull[1];
  else if (shortYear >= nowYear - 1 && shortYear <= nowYear + 7) out.classYear = shortYear;
  else if (full.length) out.classYear = Math.min(...full);

  // Position. Three traps, all seen in live data:
  //   "FB" in a recruit bio nearly always means FOOTBALL, not fullback —
  //       "Garces memorial high school | W189 | FB (WR and FS)"  -> the position is WR
  //   bare "S" / "P" collide with ordinary prose
  //   an explicit "Pos:" label is authoritative and must win —
  //       "6'2 255|Pos:DL/LB/H|3 Sport Athlete"
  // RT/LT/RG/LG belong here but NOT in rules.js findPosition(): on X post text "RT"
  // means retweet, in a stat-block bio it means right tackle. "C/28 6-3 280 RT/G" is a
  // tackle with two line-position codes, not a fullback.
  const POS = 'QB|RB|FB|WR|TE|OT|LT|RT|OG|LG|RG|OL|IOL|DL|DE|DT|EDGE|LB|ILB|OLB|CB|DB|FS|SS|S|SAF|ATH|K|P|LS';
  const labelled = t.match(new RegExp(`\\bPos(?:ition)?\\s*[:\\-]\\s*(${POS})\\b`, 'i'));
  const worded = t.match(/\b(quarterback|running back|wide receiver|tight end|offensive (?:tackle|guard|lineman)|o\s*tackle|defensive (?:tackle|end|lineman|back)|d[- ]?end|linebacker|cornerback|free safety|strong safety|safety|long snapper|kicker|punter)\b/i);
  const wordMap = { quarterback: 'QB', 'running back': 'RB', 'wide receiver': 'WR', 'tight end': 'TE',
    'offensive tackle': 'OT', 'offensive guard': 'OG', 'offensive lineman': 'OL', 'o tackle': 'OT',
    'defensive tackle': 'DT', 'defensive end': 'DE', 'defensive lineman': 'DL',
    'd-end': 'DE', 'd end': 'DE', 'defensive back': 'DB', linebacker: 'LB', cornerback: 'CB',
    'free safety': 'S', 'strong safety': 'S', safety: 'S', 'long snapper': 'LS', kicker: 'K', punter: 'P' };
  if (labelled) {
    const p = labelled[1].toUpperCase();
    out.position = p === 'FS' || p === 'SS' ? 'S' : p;
  } else if (worded) {
    out.position = wordMap[worded[1].toLowerCase()];
  } else {
    const positions = [...new Set([...t.matchAll(new RegExp(`\\b(${POS})\\b`, 'gi'))].map((m) => m[1].toUpperCase()))]
      .filter((p) => !['C', 'S', 'K', 'P'].includes(p) || new RegExp(`(?:pos(?:ition)?\\s*[:=-]\\s*${p}\\b|\\b${p}\\s*[/|,]\\s*[A-Z]{1,4}\\b|\\b[A-Z]{1,4}\\s*[/|,]\\s*${p}\\b)`, 'i').test(t))
      .sort((a, b) => Number(a === 'ATH') - Number(b === 'ATH'))
      // Keep FB only when written as a real position ("RB/FB") or spelled out.
      .filter((p) => p !== 'FB' || /\/\s*FB\b|\bFB\s*\/|\bfullback\b/i.test(t))
      .map((p) => p === 'FS' || p === 'SS' ? 'S' : p);
    if (positions.length) out.position = positions[0];
  }

  const ht = t.match(/\b(\d)\s*['\u2018\u2019]\s*(\d{1,2})\b/);
  if (ht) out.height = `${ht[1]}-${ht[2]}`;
  const wt = t.match(/\b(1[4-9]\d|2[0-9]\d|3[0-5]\d)\s*(?:lbs?\b|\|)/i)
    || t.match(/\b(\d)\s*['\u2018\u2019]\s*\d{1,2}\s+(1[4-9]\d|2[0-9]\d|3[0-5]\d)\b/);
  if (wt) out.weight = +(wt[2] || wt[1]);

  const forty = t.match(/\b([3-5]\.\d{1,2})\s*(?:40|forty)\b/i) || t.match(/\b40\s*[:\-]?\s*([3-5]\.\d{1,2})\b/);
  if (forty) out.forty = +forty[1];
  // Allow qualifiers between the number and the label: "4.19 weighted gpa".
  const gpa = t.match(/\b([0-5]\.\d{1,2})\s*(?:\w+\s+){0,2}GPA\b/i)
    || t.match(/\bGPA\s*[:\-]?\s*(?:\w+\s+){0,2}([0-5]\.\d{1,2})\b/i);
  if (gpa) out.gpa = +gpa[1];
  const stars = t.match(/\b([1-5])\s*(?:\u2b50\ufe0f?|stars?\b)/i);
  if (stars) out.stars = +stars[1];

  // State codes are dense collision territory in bios. Live failures: "NCAA
  // ID:2602827047" read as Idaho, and IN / OR / OK / ME / HI / DE are ordinary English
  // words. Strip the known ID-number patterns, then require the code to sit in a
  // location-shaped slot rather than float in prose.
  const cleaned = t.replace(/\bNCAA\s*ID\s*[:#]?\s*\d+/gi, ' ').replace(/\bID\s*[:#]\s*\d+/gi, ' ');
  const STATES = 'AL|AK|AZ|AR|CA|CO|CT|FL|GA|ID|IL|IA|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
  const st = cleaned.match(new RegExp(`[,(|]\\s*(${STATES})\\s*[)|,]`))
    || cleaned.match(new RegExp(`[,(]\\s*(${STATES})\\b`))
    || cleaned.match(new RegExp(`\\b(${STATES})\\s*[|)]`));
  if (st) out.state = st[1];

  const hs = t.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})\s+(?:HS|High School)\b/);
  if (hs) out.highSchool = hs[1].trim();

  return out;
}

/**
 * Is this account plausibly a football RECRUIT, rather than a coach, a media outlet, a
 * recruiting agency, or an athlete in a different sport?
 *
 * The LLM pass makes this call properly. This exists for the rules-only path, which has
 * no judgement of its own. Every rule below was written against a live false positive:
 *   "@allnonesports1 - We connect high school & transfer athletes with college programs"
 *   "@amari_price1  - c/o 2032 basketball player @exodusnyc scholar"
 */
export function looksLikeRecruit(bio, displayName = '') {
  const t = ` ${bio || ''} ${displayName || ''} `.replace(/\s+/g, ' ');
  if (!t.trim()) return { ok: false, why: 'no bio' };

  const hasFootball = /football|🏈/i.test(t);

  // Wrong sport is disqualifying outright — nothing else in the bio can rescue it.
  // ("track" is deliberately absent: nearly every football recruit also runs track.)
  // Live failure: a 2028 girls' basketball recruit ("5'11 • 3-Guard • 3.8 GPA • ...AAU")
  // offered by Alabama-Huntsville (D2 women's hoops) passed this check because her bio
  // never says the word "basketball" — it says "3-Guard" and "AAU", basketball's own
  // jargon, which the keyword list did not cover.
  if (/\b(basketball|hoops|baseball|softball|soccer|volleyball|lacrosse|hockey|wrestling|golf|tennis)\b/i.test(t) && !hasFootball) {
    return { ok: false, why: 'different sport' };
  }
  if (/\b\d\s*-\s*(?:guard|forward|center)\b|\b(?:point|shooting)?\s*guard\b|\baau\b/i.test(t) && !hasFootball) {
    return { ok: false, why: 'different sport' };
  }
  if (/\b(?:PG|SG|SF|PF)\b|\b(?:MBB|WBB)\b/i.test(t) && !hasFootball) {
    return { ok: false, why: 'different sport' };
  }
  if (/\bjuco\b|\bjunior college\b/i.test(t)) return { ok: false, why: 'not high-school recruit' };
  const bioText = String(bio || '');
  if (/(?:^|[|\u2022])\s*[^|\u2022]{0,50}\b(?:community\s+college|college|cc)\b(?=\s*(?:[|\u2022]|\d|$))/i.test(bioText))
    return { ok: false, why: 'not high-school recruit' };

  const info = parseBio([bio, displayName].filter(Boolean).join(' | '));
  const signals = ['classYear', 'position', 'height', 'weight', 'forty', 'stars', 'gpa']
    .filter((k) => info[k] != null).length;

  // Flag football is not the sport this wire tracks: an FBS scholarship offer is for
  // the tackle roster, and the new girls' flag game has its own recruiting. A recruit
  // who plays TACKLE teams names a position or a 40 time in the same bio — require that
  // before a "flag football" mention is allowed to count as football evidence.
  if (/\bflag\s+football\b/i.test(t) && !info.position && !info.forty) return { ok: false, why: 'different sport' };

  // Measurables win. A recruit bio is a stat block — class, height, weight, 40, stars —
  // and a coach's or an agency's is not. Without giving that precedence the filter
  // rejects real recruits for CREDITING their coach. Seen live, a genuine 2028 RB:
  //   "San Antonio Brennan C/O 28 | 4* | 4.0 GPA | RB/WR/ATH | 5'11" 200lbs |
  //    100m 10.8 | 40 4.4 | 21.70 MPH | 1st Team All District | Head Coach @basorecoach"
  if (signals >= 3) return { ok: true, signals, info };

  // Organisations and media speak ABOUT athletes rather than being one.
  if (/\b(we connect|we help|our mission|agency|recruiting service|exposure|media|network|podcast|magazine|coverage|analyst|scouting|official (account|page)|info@|contact us)\b/i.test(t)) {
    return { ok: false, why: 'organisation' };
  }
  // A coach states a ROLE they hold ("Head Coach at X"). A recruit naming his coach is
  // a credit, not a role — so match the role-shaped forms only.
  if (/\b(head coach|assistant coach|position coach|recruiting coordinator|director of)\s+(?:at|@|for|\|)/i.test(t)
    || /\b(coach|coordinator)\s+at\s+\w/i.test(t)
    || /\bproud (parent|mom|dad|father|mother)\b/i.test(t)) {
    return { ok: false, why: 'coach or parent' };
  }

  // A recruit bio carries hard numbers. Two independent fields is the floor; one alone
  // is as likely to be a coincidence as a recruit.
  if (signals < 2 && !hasFootball) return { ok: false, why: 'no recruit fields' };
  if (signals === 0) return { ok: false, why: 'no recruit fields' };
  return { ok: true, signals, info };
}

/** Convert a decorated X display name into a publishable human name. */
export function cleanPersonName(raw) {
  const original = String(raw || '').normalize('NFKC');
  // Some recruits use display names such as iamBraydonZeno_. Recover the explicit first
  // and last name only for that recognizable decoration; globally splitting camel case
  // would damage legitimate surnames such as McDonald.
  const iamStyle = /^_?iam[A-Z]/.test(original);
  const handleStyle = /^@[A-Z]/.test(original) || /[a-z][A-Z][\p{L}-]*20\d{2}$/u.test(original);
  let s = original
    .replace(/^_?iam(?=[A-Z])/, '')
    .replace(/_/g, ' ');
  if (iamStyle || handleStyle) s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s
    .replace(/[\u201c\u201d]\s*[\p{L}\p{N}_-]+\s*[\u201c\u201d]/gu, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F\u2B50]/gu, ' ')
    .replace(/\b[1-5]\s*[- ]?\s*stars?\b/gi, ' ')
    .replace(/\b(?:class\s+of|c\/?o|co)?\s*['\u2018\u2019]?\s*20\d{2}\b/gi, ' ')
    .replace(/\b(?:class\s+of|c\/?o)\s*['\u2018\u2019]?\s*\d{2}\b/gi, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\blll\b/gi, 'III')
    .replace(/\b(?:QB|RB|FB|WR|TE|OT|OG|OL|IOL|DL|DE|DT|EDGE|LB|ILB|OLB|CB|DB|SAF|ATH|LS|KR|RET)\b.*$/i, ' ')
    .replace(/[^\p{L}\p{M}'.\- ]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  let words = s.split(' ').filter((w) => /\p{L}/u.test(w));
  words = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  if (words.length > 2) words = words.filter((w, i) => i === 0 || i === words.length - 1 || !/^[A-Z]{2,}$/.test(w));
  if (words.length < 2 || words.length > 4) return null;
  s = words.map((w) => w.replace(/^\p{L}/u, (c) => c.toUpperCase())).join(' ');
  return nameKey(s) ? s : null;
}

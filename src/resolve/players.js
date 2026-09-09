import { norm } from './schools.js';
import { maskAwardYears } from '../extract/rules.js';

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;

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

export function fuzzyKey(raw) {
  const k = nameKey(raw);
  if (!k) return null;
  return k
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw')
    .replace(/[aeiouy]+/g, 'a')
    .replace(/(.)\1+/g, '$1');
}

const conflict = (a, b) => a != null && b != null && a !== b;

export function canMerge(a, b) {
  const ka = nameKey(a.name), kb = nameKey(b.name);
  if (!ka || !kb) return { merge: false, why: 'unparseable name', score: 0 };

  const exact = ka === kb;
  const fuzzy = fuzzyKey(a.name) === fuzzyKey(b.name);
  if (!exact && !fuzzy) return { merge: false, why: 'different name', score: 0 };

  if (conflict(a.classYear, b.classYear)) return { merge: false, why: 'class year conflict', score: 0 };
  if (conflict(a.handle, b.handle)) return { merge: false, why: 'different X handle', score: 0 };
  if (conflict(a.highSchool && norm(a.highSchool), b.highSchool && norm(b.highSchool))) {
    return { merge: false, why: 'high school conflict', score: 0 };
  }
  if (conflict(a.state, b.state)) return { merge: false, why: 'state conflict', score: 0 };

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
  if (!target.name && incoming.name) target.name = incoming.name;
  const aliases = new Set([...(target.aliases || []), target.name, incoming.name].filter(Boolean));
  target.aliases = [...aliases];
  return target;
}

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

export function parseBio(bio, nowYear = new Date().getUTCFullYear()) {
  if (!bio) return {};
  const out = {};
  const t = ' ' + bio.replace(/\s+/g, ' ') + ' ';
  const ct = ' ' + maskAwardYears(t) + ' ';

  const explicitFull = ct.match(/\b(?:class\s+of|c\/?o|class|co)\s*['\u2018\u2019]?\s*(20(?:2[5-9]|3[0-5]))\b/i);
  const full = [...ct.matchAll(/\b(20(?:2[5-9]|3[0-5]))\b/g)].map((m) => +m[1])
    .filter((y) => y >= nowYear - 1 && y <= nowYear + 7);
  const short = ct.match(/\bc\/?o\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    || ct.match(/\bclass of\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    || ct.match(/\bc\/(?:o\/)?\s*['\u2018\u2019]?\s*(\d{2})\b/i)
    || ct.match(/\bclass\s*['\u2018\u2019\u201C\u201D]?\s*(\d{2})\b/i)
    || ct.match(/\b(?:HS|High School|H\.S\.|High)\b[^0-9#]{0,8}(?:20)?(\d{2})\b/i)
    || ct.match(/(?:^|[\s|/])(\d{2})\s*['\u2018\u2019\u201C\u201D](?=$|[\s|/])/)
    || ct.match(/(?<!\d)['\u2018\u2019\u201C\u201D](\d{2})\b/);
  const shortYear = short ? 2000 + +short[1] : null;
  if (explicitFull) out.classYear = +explicitFull[1];
  else if (shortYear >= nowYear - 1 && shortYear <= nowYear + 7) out.classYear = shortYear;
  else if (full.length) out.classYear = Math.min(...full);

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
  const gpa = t.match(/\b([0-5]\.\d{1,2})\s*(?:\w+\s+){0,2}GPA\b/i)
    || t.match(/\bGPA\s*[:\-]?\s*(?:\w+\s+){0,2}([0-5]\.\d{1,2})\b/i);
  if (gpa) out.gpa = +gpa[1];
  const stars = t.match(/\b([1-5])\s*(?:\u2b50\ufe0f?|stars?\b)/i);
  if (stars) out.stars = +stars[1];

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

export function looksLikeRecruit(bio, displayName = '') {
  const t = ` ${bio || ''} ${displayName || ''} `.replace(/\s+/g, ' ');
  if (!t.trim()) return { ok: false, why: 'no bio' };

  const hasFootball = /football|🏈/i.test(t)
    || /\b(?:QB|RB|FB|WR|TE|OT|OG|OL|IOL|DL|DE|DT|EDGE|LB|ILB|OLB|CB|DB|SS|FS|SAF|ATH|LS)\b/i.test(t);

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

  if (/\bflag\s+football\b/i.test(t) && !info.position && !info.forty) return { ok: false, why: 'different sport' };

  if (signals >= 3) return { ok: true, signals, info };

  if (/\b(we connect|we help|our mission|agency|recruiting service|exposure|media|network|podcast|magazine|coverage|analyst|scouting|official (account|page)|info@|contact us)\b/i.test(t)) {
    return { ok: false, why: 'organisation' };
  }
  if (/\b(head coach|assistant coach|position coach|recruiting coordinator|director of)\s+(?:at|@|for|\|)/i.test(t)
    || /\b(coach|coordinator)\s+at\s+\w/i.test(t)
    || /\bproud (parent|mom|dad|father|mother)\b/i.test(t)) {
    return { ok: false, why: 'coach or parent' };
  }

  if (signals < 2 && !hasFootball) return { ok: false, why: 'no recruit fields' };
  if (signals === 0) return { ok: false, why: 'no recruit fields' };
  return { ok: true, signals, info };
}

export function cleanPersonName(raw) {
  const original = String(raw || '').normalize('NFKC');
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

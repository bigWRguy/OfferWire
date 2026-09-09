
export const POSITIONS = ['QB','RB','FB','WR','TE','OT','OL','IOL','OG','OC','C','ATH','DL','DE','DT','EDGE','LB','ILB','OLB','CB','S','DB','SAF','K','P','LS','KR','RET'];

const PLAYER_VOICE = [
  /\b(?:blessed|honored|humbled|excited|grateful|thankful)\b[^.!?]{0,80}\b(?:to\s+(?:receive|have\s+received|announce)|receive)\b[^.!?]{0,40}\boffer\b/i,
  /\bafter\s+a\s+(?:great|amazing|good)\s+(?:conversation|talk|call|visit)[^.!?]{0,120}\boffer(?:ed)?\b/i,
  /\bi\s+(?:have\s+)?(?:am\s+)?(?:been\s+)?(?:blessed|received|earned|got)\b[^.!?]{0,60}\boffer\b/i,
  /\breceived?\s+(?:my|an|a)\s+(?:\d+(?:st|nd|rd|th)\s+)?(?:d1\s+|division\s+1\s+|offer)\b/i,
  /\ball\s+glory\s+to\s+god[^.!?]{0,80}\boffer\b/i,
];
const REPORTER_VOICE = [
  /\bhas\s+been\s+offered\s+by\b/i,
  /\bhas\s+(?:received|picked\s+up|landed|earned)\s+an?\s+offer\s+from\b/i,
  /\bpicks?\s+up\s+(?:an?\s+)?offer\s+from\b/i,
  /\bhas\s+offered\b/i,
  /\bextends?\s+an?\s+offer\s+to\b/i,
  /\boffered\s+by\b/i,
  /\bnew\s+offer\b/i,
  /\badds?\s+an?\s+offer\s+from\b/i,
  /\bhanded\s+out\s+an?\s+offer\b/i,
  /\boffers\s+(?:\d{4}|\d+\s+(?:star|\*)|three|two|four|five)/i,
  /\boffers\s+(?:\d{4}\s+)?[A-Z]{2,5}\s+[A-Z][a-z]/,
  /\b(?:picks?|picked)\s+up\s+(?:an?\s+|\d+\s+)?offers?\b/i,
  /\boffers?\s+from\s+@?\w/i,
  /\breceiv(?:es|ed|ing)\s+(?:an?\s+|his\s+|her\s+|\d+\s+)?(?:\w+\s+){0,2}offers?\b/i,
  /\breport(?:ed|s)\s+an?\s+(?:\w+\s+){0,3}offer\b/i,
  /\b(?:picked|picks)\s+up\s+an?\s+(?:\w+\s+){0,3}offer\b/i,
  /\bland(?:ed|s)\s+an?\s+(?:\w+\s+){0,3}offer\b/i,
];
const BARE = [/\boffers?\b/i, /\boffered\b/i];

const NEGATIVE = [
  /\bcommit(?:ted|ment|ting|s)?\b/i,
  /\bdecommit/i,
  /\bflip(?:ped|s)?\b/i,
  /\bsign(?:ed|ing)\b/i,
  /\bnarrow(?:ed|s)?\s+(?:down|his|her)?\s*(?:list|top)/i,
  /\b(?:my|his|her|final|announces?\s+(?:his|her)?)\s*top\s*\d{1,2}\b/i,
  /\btop\s*\d{0,2}\s*(?:schools|programs|list|choices)\b/i,
  /\bannounc\w*\s+(?:my|his|her)\s+top\b/i,
  /\bfinal(?:ist|ists|\s+\d)\b/i,
  /\boffer\s+list\b/i,
  /\bofferlist\b/i,
  /\bwalk[\s-]?on\b/i, /\bpwo\b/i, /\bpreferred\s+walk/i,
  /\bgrayshirt|greyshirt\b/i,
  /\bcamp\s+invite\b/i, /\binvite(?:d)?\s+to\s+(?:camp|junior\s+day)/i,
  /\bthrowback\b/i, /\bon\s+this\s+day\b/i, /\byears?\s+ago\s+today\b/i,
  /\bwould\s+(?:you|they)\s+offer\b/i, /\bshould\s+\w+\s+offer\b/i,
  /\bwho\s+(?:else\s+)?should\b/i,
  /\bnil\s+deal\b/i, /\bportal\b/i, /\btransfer\s+portal\b/i,
  /\bofficial\s+visit\s+set\b/i,
  /\b(?:scholarship\s+)?offer\s+(?:code|expires)\b/i,
  /\b(?:has|have|had|holds?|held|boasts?)\s+offers?\s+(?:from|at)\b/i,
];

export function maskAwardYears(text) {
  const t = String(text || '');
  return t
    .replace(/\b(?:[A-Za-z0-9]+[\s-])?all[\s-]+[A-Z0-9][A-Za-z0-9./-]{1,18}\s*['\u2018\u2019]?\s*(?:20\d{2}|\d{2})\b/gi, ' ')
    .replace(/\b(20\d{2}|\d{2})\s*(?:1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|honorable\s+mention)\s*[- ]?\s*team\b/gi, ' ')
    .replace(/\b(?:national|state|regional|district|conference|city|county|[\w./-]+)\s+(?:champs?|champions?)\b\s*['\u2018\u2019]?\s*(?:20\d{2}|\d{2})\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findClassYear(text, nowYear = new Date().getUTCFullYear()) {
  const raw = maskAwardYears(text || '');
  const explicit = raw.match(/\b(?:class\s+of|c\/?o|class|co)\s*['\u2018\u2019]?\s*(20\d{2}|\d{2})\b/i)
    || raw.match(/\bc\/(?:o\/)?\s*['\u2018\u2019]?\s*(20\d{2}|\d{2})\b/i)
    || raw.match(/(?:^|[\s|/])(\d{2})\s*['\u2018\u2019\u201C\u201D](?=$|[\s|/])/)
    || raw.match(/(?<!\d)['\u2018\u2019\u201C\u201D](\d{2})\b/);
  if (explicit) {
    const y = explicit[1].length === 2 ? 2000 + Number(explicit[1]) : Number(explicit[1]);
    if (y >= nowYear - 1 && y <= nowYear + 7) return y;
  }
  const m = [...raw.matchAll(/\b(20\d{2})\b/g)].map((x) => +x[1]);
  const c = m.filter((y) => y >= nowYear && y <= nowYear + 6);
  return c.length ? Math.min(...c) : null;
}

export function handleClassYear(handle, nowYear = new Date().getUTCFullYear()) {
  const m = String(handle || '').match(/(?:^|_|-|(?<=\D))(20\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= nowYear - 1 && y <= nowYear + 7 ? y : null;
}

export function findPosition(text) {
  const t = (text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/#\S+/g, ' ');
  const worded = t.match(/\b(quarterback|running back|wide receiver|tight end|offensive (?:tackle|guard|lineman)|o\s*tackle|defensive (?:tackle|end|lineman|back)|d[- ]?end|linebacker|cornerback|free safety|strong safety|safety|long snapper|kicker|punter)\b/i);
  if (worded) {
    const w = worded[1].toLowerCase().replace(/\s+/g, ' ');
    if (/quarterback/.test(w)) return 'QB'; if (/running back/.test(w)) return 'RB';
    if (/wide receiver/.test(w)) return 'WR'; if (/tight end/.test(w)) return 'TE';
    if (/offensive tackle|o tackle/.test(w)) return 'OT'; if (/offensive guard/.test(w)) return 'OG';
    if (/offensive lineman/.test(w)) return 'OL'; if (/defensive tackle/.test(w)) return 'DT';
    if (/defensive end|d-end|d end/.test(w)) return 'DE'; if (/defensive lineman/.test(w)) return 'DL';
    if (/defensive back/.test(w)) return 'DB'; if (/linebacker/.test(w)) return 'LB';
    if (/cornerback/.test(w)) return 'CB'; if (/safety/.test(w)) return 'S';
    if (/long snapper/.test(w)) return 'LS'; if (/kicker/.test(w)) return 'K'; if (/punter/.test(w)) return 'P';
  }
  for (const p of POSITIONS) {
    if (p === 'FB' && !/\/\s*FB\b|\bFB\s*\/|\bfullback\b/i.test(t)) continue;
    if (['C', 'S', 'K', 'P'].includes(p) && !new RegExp(`(?:pos(?:ition)?\\s*[:=-]\\s*${p}\\b|\\b${p}\\s*[/|,]\\s*[A-Z]{1,4}\\b|\\b[A-Z]{1,4}\\s*[/|,]\\s*${p}\\b)`, 'i').test(t)) continue;
    if (new RegExp(`(?:^|[^A-Z])${p}(?:[^A-Z]|$)`).test(t)) return p;
  }
  return null;
}

const STOP_NAME = new Set(['the','a','an','and','of','from','to','by','has','have','is','was','with','after','my','his','her','their','coach','offer','offers','offered','breaking','news','congrats','congratulations','blessed','received','receive','all','glory','god','division','football','star','class','commit','committed','via','per','update','exclusive']);

export function findNameCandidates(text) {
  const cleaned = (text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/#\S+/g, ' ');
  const out = [];
  const re = /\b([A-Z][a-zA-Z'’.-]{1,20}(?:\s+(?:Jr\.?|Sr\.?|II|III|IV))?)\s+([A-Z][a-zA-Z'’.-]{1,20})(?:\s+((?:Jr\.?|Sr\.?|II|III|IV)|[A-Z][a-zA-Z'’.-]{1,20}))?/g;
  for (const m of cleaned.matchAll(re)) {
    const parts = [m[1], m[2], m[3]].filter(Boolean);
    if (parts.some((p) => STOP_NAME.has(p.toLowerCase().replace(/[^a-z]/g, '')))) continue;
    const name = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (name.split(' ').length < 2) continue;
    out.push({ name, index: m.index });
  }
  return out;
}

export function classify(text) {
  const t = text || '';
  const neg = NEGATIVE.filter((r) => r.test(t)).map((r) => r.source);
  const player = PLAYER_VOICE.some((r) => r.test(t));
  const reporter = REPORTER_VOICE.some((r) => r.test(t));
  const bare = BARE.some((r) => r.test(t));

  let kind = null, base = 0;
  if (player) { kind = 'player_voice'; base = 0.72; }
  else if (reporter) { kind = 'reporter_voice'; base = 0.7; }
  else if (bare) { kind = 'bare_mention'; base = 0.35; }

  const multiSchoolRecap = /\boffers?\s+from\s+(?:[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})(?:\s*,\s*(?:[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})){2,}/.test(t);
  const staleOffer = /\b(?:previously|already|formerly)\s+(?:had\s+)?offer(?:ed|s)?\b|\bhad\s+(?:an?\s+)?offers?\s+from\b|\boffers?\s+include\b|\b(?:holds?|with)\s+\d+\+?\s+offers?\b|\bholds?\s+(?:an?\s+)?#?(?:(?:division\s*(?:one|1|i)|d1)\s+)?offers?\s+from\b|\b(?:recent|previous)\s+offers?\b|\boffer\s+(?:a few|several|\d+)\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b(?:landed|earned|received|picked\s+up)\b[^.!?]{0,100}\boffer\b[^.!?]{0,100}\b(?:during|following)\s+(?:a\s+\w+\s+)?(?:the\s+)?(?:spring|summer|fall|winter)\b|\brecognition\b[^.!?]{0,100}\bduring\s+(?:the\s+)?(?:spring|summer|fall|winter)\b[^.!?]{0,100}\b(?:landed|earned|received|picked\s+up)\b[^.!?]{0,60}\boffer\b/i.test(t);
  const aspirational = /\b(?:an?\s+)?offer\s+would\s+be\b|\bhope(?:ful|fully)?\s+(?:to\s+)?(?:get|receive|earn)\b[^.!?]{0,30}\boffer\b/i.test(t);
  const nonScholarship = /\bprep\s+school\s+offer\b|\boffer\s+to\s+play\s+football\s+at\b/i.test(t);
  const nonFbsLevel = /\b(?:d[23]|division\s*(?:ii|iii|2|3|two|three)|naia|njcaa|juco)\s+(?:scholarship\s+)?offer\b/i.test(t);
  const otherSportOffer = /\b(?:baseball|basketball|softball|soccer|volleyball|lacrosse|hockey)\s+(?:scholarship\s+)?offer\b|\boffer\s+to\s+play\s+(?:baseball|basketball|softball|soccer|volleyball|lacrosse|hockey)\b/i.test(t);
  const recapStatesOffer = /\b(?:has|have|had|holds?|held|boasts?)\s+offers?\s+(?:from|at)\b/i.test(t);
  const newOfferVerb = /\b(?:receiv\w+|was\s+offered|has\s+been\s+offered|being\s+offered|offered\s+by|officially\s+offered|extends?\s+an?\s+offer|lands?\s+an?\s+offer|landed\s+an?\s+offer|earned\s+an?\s+offer|picked?\s+up\s+(?:an?|a|\d+\w*)\s+offer|got\s+\w+\s+(?:\w+\s+)*offer)\b/i.test(t);
  const hardRecap = recapStatesOffer && !newOfferVerb;
  const hard = multiSchoolRecap || staleOffer || aspirational || nonScholarship || nonFbsLevel || otherSportOffer || hardRecap || /\bcommit(?:ted|ment|ting|s)?\b|\bdecommit|\bsigning day\b|\bofferlist\b|\boffer list\b|\bwalk[\s-]?on\b|\bpwo\b|\bthrowback\b|\bon this day\b/i.test(t);
  if (hard) return { kind, prior: 0, negatives: neg, hardNegative: true };

  const prior = Math.max(0, base - 0.12 * neg.length);
  return { kind, prior, negatives: neg, hardNegative: false };
}

const NEVER_THE_RECRUIT = /(football|athletics|recruit|sports|coach|hs$|highschool|academy|prep|nation|report|media|network|scout|rivals|247|365|on3|espn|team|official|_fb$|fb_|gridiron|allday|elite|camp)/i;

export function findTaggedRecruit(post, schools, known) {
  const cands = (post.mentioned || []).filter((m) => {
    if (schools.has(m.handle) || known.has(m.handle)) return false;
    if (NEVER_THE_RECRUIT.test(m.handle)) return false;
    if (/(high school|\bhs\b|athletic|\bsports?\b|official|football\s*$)/i.test(m.name || '')) return false;
    return true;
  });
  if (cands.length !== 1) return null;
  const c = cands[0];
  const stripped = (c.name || '').replace(/[^\p{L}\p{M}'.\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const clean = stripped.replace(/\p{L}[\p{L}'-]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const looksHuman = /^[\p{Lu}][\p{L}'.-]+(?:\s+[\p{Lu}][\p{L}'.-]+){1,2}$/u.test(clean);
  return { handle: c.handle, name: looksHuman ? clean : null };
}

const NAME = String.raw`([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})`;
const REPORTER_GRAMMARS = [
  new RegExp(NAME + String.raw`\s+(?:has\s+)?(?:been\s+)?(?:offered\b|received\s+an?\s+offer|picked\s+up\s+an?\s+offer|picks\s+up\s+an?\s+offer|lands?\s+an?\s+offer|earns?\s+an?\s+offer|adds?\s+an?\s+offer|brings\s+in\s+an?\s+\w+\s+offer)`),
  new RegExp(String.raw`(?:has\s+offered|offered|extends?\s+an?\s+offer\s+to|offer\s+to)\s+(?:the\s+)?(?:(?:\d{4}|\d{1,3}|[a-z-]+-star|[A-Z]{1,5}(?:\/[A-Z]{1,5})*)\s+){0,3}` + NAME),
  new RegExp(String.raw`\b20\d{2}\s+(?:(?:[a-z-]+|\d{1,3}|[A-Z]{1,5}(?:\/[A-Z]{1,5})*)\s+){0,3}` + NAME),
];

export function findReportedName(text) {
  const t = (text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}]/gu, ' ')
    .replace(/\b\d\s*(?:star|stars|\*)\b/gi, ' ')
    .replace(/\bNat'?l\b|\bcomposite\b|\bNo\.?\s*\d+\b|\brank(?:ed|ing)?\b/gi, ' ')
    .replace(/["“”]\s*[\w-]+\s*["“”]/g, ' ')
    .replace(/\s+/g, ' ');
  for (const re of REPORTER_GRAMMARS) {
    const m = t.match(re);
    if (!m) continue;
    let name = m[1].replace(/\s+/g, ' ').trim();
    name = name
      .replace(/\.\s+(?:profile|highlights?|film|story|read\s+more)\.?$/i, '')
      .trim();
    const lead = name.match(new RegExp(`^(?:${POSITIONS.join('|')})\\s+(.+)$`));
    if (lead && lead[1].split(' ').length >= 2) name = lead[1];
    const words = name.split(' ');
    if (words.some((w) => STOP_NAME.has(w.toLowerCase().replace(/[^a-z]/g, '')))) continue;
    if (/^(Ole|Texas|Michigan|Ohio|Florida|Georgia|Notre|Boston|Penn|Iowa|Kansas|Oregon|Arizona|Miami|West|North|South|East|New|Wake|Virginia|Washington|Oklahoma|Mississippi|Louisiana|Colorado|Central|Northern|Southern|Western|Eastern|Appalachian|Coastal|Middle|Old|Sam|San|Air)\b/.test(name)) continue;
    if (/\b(?:high school|school|hs|academy|university|college|memorial)\b/i.test(name)) continue;
    if (words.length >= 2) return name;
  }
  return null;
}

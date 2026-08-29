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
  // Half the FBS is named after a state, so a recruit HOMETOWN reads as a program:
  //   "Florida has offered 4-star 2028 WR Malachi Lee out of ... Leesburg, Virginia."
  // Florida offered him; Virginia is where he lives. Filing that as a Virginia offer
  // would be a fabricated row, so strip location-shaped mentions before matching.
  // Handle matches are unaffected - that pass already ran and is exact.
  const STATE_NAMES = new RegExp("(,\\s*|\\bin\\s+|\\bout\\s+of\\s+[^,]{0,40},\\s*)(Alabama|Arizona|Arkansas|California|Colorado|Connecticut|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|New Mexico|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|South Carolina|Tennessee|Texas|Utah|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\\b(?!\\s*(?:State|Tech|A&M|Football|offer))", 'gi');
  // A school-named CITY immediately followed by a state is a hometown too:
  //   "a kid out of Houston, Texas" names neither Houston nor Texas as a program.
  const CITY_THEN_STATE = new RegExp("\\b(Houston|Miami|Buffalo|Cincinnati|Memphis|Charlotte|Toledo|Akron|Tulsa|Auburn|Boise|Fresno|Reno|Baylor|Rice|Temple|Troy|Duke|Rutgers|Syracuse)\\s*,\\s*(?:Alabama|Arizona|Arkansas|California|Colorado|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|New York|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|South Carolina|Tennessee|Texas|Utah|Virginia|Washington|Wisconsin|[A-Z]{2}\\b)", 'gi');
  // "Central Arkansas", "Northern Colorado", "Southeastern Louisiana" — a directional
  // prefix in front of a bare state name is an FCS/D2 program that happens to share the
  // state's name, not the FBS school. Real live failure: "offered by Nathan Brown and
  // Central Arkansas" filed as a Razorbacks (Arkansas) offer. FBS names that legitimately
  // start this way ("North Texas", "South Carolina", "West Virginia"...) are matched at
  // full length earlier in FORM_LIST and are gone from `hay` by the time this would fire,
  // so stripping the bare tail here cannot cost them.
  const REGIONAL_STATE = new RegExp("\\b(?:Central|Northern|Southern|Eastern|Western|Northeastern|Northwestern|Southeastern|Southwestern)\\s+(Alabama|Arizona|Arkansas|California|Colorado|Connecticut|Florida|Georgia|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|Ohio|Oklahoma|Oregon|Pennsylvania|Tennessee|Texas|Utah|Virginia|Washington|Wisconsin|Wyoming)\\b", 'gi');
  // "Alabama State University" is FCS/SWAC, not the FBS "Alabama" (Crimson Tide) — there
  // is no FBS "Alabama State" to consume the phrase first, so the bare state name was
  // left exposed underneath it. Live failure: a girls'-basketball offer from Alabama
  // State filed as a Crimson Tide football offer. Only strip "<state> State [University]"
  // for states whose "State" school is NOT itself in the FBS roster — Arizona State, Ohio
  // State etc. already match their own full-length form earlier and must reach it intact.
  const FBS_STATE_NAMES = new Set(SCHOOLS.filter((s) => /\bState\b/.test(s.name)).map((s) => s.name.replace(/\s+State\b.*/, '')));
  const NON_FBS_STATE_SCHOOLS = ['Alabama', 'Alaska', 'Delaware', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Maine', 'Minnesota', 'Montana', 'Nevada', 'New York', 'North Dakota', 'Norfolk', 'South Dakota', 'Tennessee', 'Wisconsin']
    .filter((n) => !FBS_STATE_NAMES.has(n));
  const STATE_UNIV = new RegExp(`\\b(${NON_FBS_STATE_SCHOOLS.join('|')})\\s+State(?:\\s+University)?\\b`, 'gi');
  // "University of Alabama - Huntsville" / "University of Alabama at Birmingham" are
  // separate D2/non-FBS branch campuses, not the FBS flagship. Live failure: an
  // Alabama-Huntsville women's-basketball offer filed as a Crimson Tide football offer.
  // Strip the branch-campus tail so the bare "university of X" form cannot fire on it.
  const BRANCH_CAMPUS = /\b(university\s+of\s+\w+)\s*[-–—]\s*\w+|\b(university\s+of\s+\w+)\s+at\s+\w+/gi;
  const NON_FBS_SUFFIX = /\b(Alabama|Arizona|Arkansas|California|Colorado|Florida|Georgia|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maryland|Michigan|Minnesota|Mississippi|Missouri|Nebraska|Nevada|Ohio|Oklahoma|Oregon|Tennessee|Texas|Utah|Virginia|Washington|West Virginia|Wisconsin)\s+(?:Tech|Baptist|Wesleyan|Christian|College)\b/gi;
  const NON_FBS_PREFIX = /\b(?:North|South|East|West|Central|Northern|Southern|Eastern|Western)\s+(Alabama|Arizona|Arkansas|California|Colorado|Florida|Georgia|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Michigan|Mississippi|Missouri|Nebraska|Ohio|Oklahoma|Oregon|Texas|Virginia|Washington)(?:\s+University)?\b/gi;
  const NON_FBS_STATE = /\b(?:Alabama|Delaware|Idaho|Illinois|Indiana|Montana|South Carolina|Tennessee)\s+State(?:\s+University)?\b/gi;
  const NAMED_BRANCH = /\bArkansas\s+State\s+University\s+Mid[- ]South\b/gi;
  const deBranched = (raw || '').replace(BRANCH_CAMPUS, ' ').replace(NAMED_BRANCH, ' ').replace(NON_FBS_SUFFIX, ' ').replace(NON_FBS_PREFIX, ' ').replace(NON_FBS_STATE, ' ');
  const deLocated = deBranched.replace(CITY_THEN_STATE, ' ').replace(REGIONAL_STATE, ' ').replace(STATE_UNIV, ' ').replace(STATE_NAMES, (m, pre) => pre + ' ');

  let hay = ' ' + norm(deLocated.replace(/#([A-Za-z]+)/g, (_, w) => ' ' + w.replace(/([a-z])([A-Z])/g, '$1 $2') + ' ')) + ' ';
  const consume = (form) => { hay = hay.split(' ' + form + ' ').join('     '); };

  for (const form of FORM_LIST) {
    if (!hay.includes(' ' + form + ' ')) continue;
    const ids = [...forms.get(form)];

    if (ids.length === 1) {
      const id = ids[0];
      consume(form);
      if (!hits.has(id)) {
        hits.set(id, { id, surface: form, method: 'name', confidence: form.length > 6 ? 0.92 : 0.8 });
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

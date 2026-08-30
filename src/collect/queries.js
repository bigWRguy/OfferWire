// The query set. This is the coverage surface — if an offer is not matched by one of
// these strings, it does not exist as far as the wire is concerned.
//
// The spine is PER-SCHOOL. Every FBS program gets its own query, every sweep, asking X
// directly what has been said about that school and an offer since we last looked. Two
// reasons that beats any phrase-only approach:
//
//   * It is exhaustive by construction. 136 schools is the entire universe of FBS
//     offers. A phrase list can always be missing a phrasing; a school list cannot be
//     missing a school.
//   * It bounds the result set per query, which makes incremental `since_time` sweeps
//     cheap and makes pagination terminate. A single global "offer" query returns
//     firehose volume and truncates; "Alabama + offer since 10:42" returns a handful.
//
// Phrase queries still run, as a second axis: they catch the post that names no school
// in a way we can match (an offer graphic captioned only "BLESSED 🙏 @CoachSmith") and
// they let a recruit be discovered by their own announcement. School × phrase is the
// grid; neither axis alone covers it.
import { SCHOOLS } from '../resolve/schools.js';

// Terms that mean "an offer happened", in the compact form X's query parser accepts.
// NB: no "commit"/"committed" here. Commitment posts are rejected downstream, so
// including them only widens the result set, burns page budget, and pushes real offers
// off the end of a truncated page. Breadth belongs on the school side, not this side.
const OFFER_TERMS = '(offer OR offered OR offers OR "blessed to receive")';

// Exclusions applied to every query. These are the categories that generate the most
// volume and the least value: retweets (duplicate the original we already have),
// commitment/portal chatter, and the recap posts that list old offers.
const EXCLUDE = '-filter:retweets -"walk-on" -"preferred walk" -"transfer portal" -"offer list"';

/**
 * The per-school queries. One per program.
 *
 * The school clause is deliberately broad — handle OR full name OR distinctive
 * nickname — because an offer post may tag the program, name it, or only use its
 * nickname. It is then narrowed by the offer terms, so breadth on the school side does
 * not translate into volume.
 */
export function schoolJobs() {
  return SCHOOLS.map((s) => {
    const surfaces = [`@${s.handle}`, `"${s.name}"`];
    // Add the nickname only when it is distinctive. "Tigers" or "Bulldogs" would drown
    // the query in four other programs' traffic and blow the page budget.
    if (!AMBIGUOUS_NICKNAMES.has(s.nickname.toLowerCase())) surfaces.push(`"${s.nickname}"`);
    // One high-signal alias, when the school has one that is not just an abbreviation
    // collision (handled by the same set).
    const alias = (s.aliases || []).find((a) => a.length > 3 && !AMBIGUOUS_NICKNAMES.has(a.toLowerCase()));
    if (alias) surfaces.push(`"${alias}"`);

    return {
      key: s.id,
      query: `(${surfaces.join(' OR ')}) ${OFFER_TERMS} ${EXCLUDE}`,
      priority: PRIORITY[s.conference] ?? 1,
      kind: 'school',
    };
  });
}

// Nicknames and short aliases shared by several programs. Including these in a query
// makes it return another school's traffic, which wastes the page budget and pushes the
// posts we actually wanted off the end.
const AMBIGUOUS_NICKNAMES = new Set([
  'tigers', 'bulldogs', 'wildcats', 'cougars', 'huskies', 'aggies', 'cardinals',
  'spartans', 'panthers', 'eagles', 'owls', 'rebels', 'falcons', 'broncos', 'cowboys',
  'rams', 'trojans', 'hurricanes', 'knights', 'blazers', 'pirates', 'lobos', 'utes',
  'bears', 'wolfpack', 'wolf pack', 'jaguars', 'chippewas', 'bobcats', 'redhawks',
  'miners', 'monarchs', 'flames', 'gamecocks', 'buffaloes', 'sun devils', 'mustangs',
  'bearcats', 'volunteers', 'orange', 'cardinal', 'midshipmen', 'minutemen',
]);

// Programs that recruit nationally generate the most offer volume, so when the sweep
// cannot reach everyone in one cycle they go first among equally-stale schools.
const PRIORITY = { SEC: 5, B1G: 5, B12: 4, ACC: 4, IND: 3, AAC: 2, MW: 2, SBC: 2, CUSA: 2, MAC: 2, PAC: 2 };

/**
 * The phrase axis. These run alongside the school sweep and are what catch a recruit
 * announcing an offer in a post that our school matcher cannot resolve — the single
 * biggest source of "a player nobody has covered yet".
 */
export function phraseJobs() {
  const P = (q, priority = 5) => ({ key: 'phrase:' + q.slice(0, 40), query: `${q} -filter:retweets`, priority, kind: 'phrase' });
  return [
    // Player voice. Highest-yield strings in the system: this is how a kid with 40
    // followers announces the offer no service has logged.
    P('"blessed to receive an offer"'),
    P('"blessed to receive my"'),
    P('"extremely blessed to receive"'),
    P('"honored to receive an offer"'),
    P('"humbled to receive an offer"'),
    P('"grateful to receive an offer"'),
    P('"thankful to receive an offer"'),
    P('"blessed to have received an offer"'),
    P('"after a great conversation" offer'),
    P('"all glory to god" offer'),
    P('"AGTG" offer'),
    // First-offer language — the exact moment a player becomes findable, and the moment
    // the ranking services are slowest on.
    P('"my first D1 offer"'),
    P('"my first Division 1 offer"'),
    P('"1st D1 offer"'),
    P('"received my first offer"'),
    P('"earned my first offer"'),
    // Reporter voice — corroboration for the school sweep, and coverage of programs
    // whose own accounts stay quiet.
    P('"has been offered by" football', 4),
    P('"picks up an offer from"', 4),
    P('"picked up an offer from"', 4),
    P('"receives an offer from"', 4),
    P('"lands an offer from"', 4),
    P('"extends an offer to"', 4),
    P('"has offered" recruit', 3),
  ];
}

/**
 * Class-scoped sweeps. Lower priority; they exist to catch offer posts whose phrasing we
 * never anticipated but which name the recruiting class, as nearly all of them do.
 */
export function classJobs(now = new Date()) {
  const y = now.getUTCFullYear();
  return [y, y + 1, y + 2, y + 3, y + 4].map((c) => ({
    key: `class:${c}`,
    query: `"${c}" (offer OR offered) (QB OR RB OR WR OR TE OR OL OR DL OR LB OR DB OR ATH OR EDGE) -filter:retweets ${EXCLUDE}`,
    priority: 2,
    kind: 'class',
  }));
}

/** Everything the sweeper should consider, in one list. */
export function allJobs() {
  return [...schoolJobs(), ...phraseJobs(), ...classJobs()];
}

/**
 * Freeze the initial historical window. If the anchor moved forward every midnight,
 * the oldest unfinished day would disappear and a slow backfill could chase the window
 * forever without completing it. Live watermarks cover everything after this anchor.
 */
export function backfillAnchorDate(state, fallback = new Date()) {
  // OFFERWIRE_BACKFILL_ANCHOR (repo variable or env) re-anchors the window with no state
  // surgery and no race with an in-flight wire run. It is committed into state on first
  // use, so deleting the variable later keeps the window where this run put it.
  const envAnchor = process.env.OFFERWIRE_BACKFILL_ANCHOR;
  const candidate = envAnchor || state.backfillAnchorAt || state.firstRunAt;
  const parsed = candidate ? new Date(candidate) : new Date(fallback);
  const anchor = Number.isFinite(parsed.getTime()) ? parsed : new Date(fallback);
  // Commit the anchor into state so a later run without the variable keeps this window.
  state.backfillAnchorAt = anchor.toISOString();
  return anchor;
}

/**
 * Historical coverage is split into one UTC day per school. A month-wide query can
 * silently hit X's result ceiling for busy programs; daily slices keep each result set
 * small, make progress resumable, and give every school an explicit completion mark.
 */
export function backfillJobs(days = 30, now = new Date()) {
  const count = Math.max(0, Math.floor(Number(days) || 0));
  if (!count) return [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 86400e3;
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const schools = schoolJobs();
  const jobs = [];
  for (let ago = count; ago >= 1; ago--) {
    const start = date(today - ago * day);
    const end = date(today - (ago - 1) * day);
    for (const school of schools) {
      jobs.push({
        key: `backfill:${school.key}:${start}`,
        query: `${school.query} since:${start} until:${end}`,
        priority: 0,
        kind: 'backfill',
        fixedWindow: true,
        schoolId: school.key,
        start,
        end,
      });
    }
  }
  return jobs;
}

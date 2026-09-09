import { SCHOOLS } from '../resolve/schools.js';

const OFFER_TERMS = '(offer OR offered OR offers OR "blessed to receive")';

const EXCLUDE = '-filter:retweets -"walk-on" -"preferred walk" -"transfer portal" -"offer list"';

export function schoolJobs() {
  return SCHOOLS.map((s) => {
    const surfaces = [`@${s.handle}`, `"${s.name}"`];
    if (!AMBIGUOUS_NICKNAMES.has(s.nickname.toLowerCase())) surfaces.push(`"${s.nickname}"`);
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

const AMBIGUOUS_NICKNAMES = new Set([
  'tigers', 'bulldogs', 'wildcats', 'cougars', 'huskies', 'aggies', 'cardinals',
  'spartans', 'panthers', 'eagles', 'owls', 'rebels', 'falcons', 'broncos', 'cowboys',
  'rams', 'trojans', 'hurricanes', 'knights', 'blazers', 'pirates', 'lobos', 'utes',
  'bears', 'wolfpack', 'wolf pack', 'jaguars', 'chippewas', 'bobcats', 'redhawks',
  'miners', 'monarchs', 'flames', 'gamecocks', 'buffaloes', 'sun devils', 'mustangs',
  'bearcats', 'volunteers', 'orange', 'cardinal', 'midshipmen', 'minutemen',
]);

const PRIORITY = { SEC: 5, B1G: 5, B12: 4, ACC: 4, IND: 3, AAC: 2, MW: 2, SBC: 2, CUSA: 2, MAC: 2, PAC: 2 };

export function phraseJobs() {
  const P = (q, priority = 5) => ({ key: 'phrase:' + q.slice(0, 40), query: `${q} -filter:retweets`, priority, kind: 'phrase' });
  return [
    P('"blessed to receive"'),
    P('"blessed to have received"'),
    P('"honored to receive an offer"'),
    P('"humbled to receive an offer"'),
    P('"grateful to receive an offer"'),
    P('"thankful to receive an offer"'),
    P('"after a great conversation" offer'),
    P('"all glory to god" offer'),
    P('"AGTG" offer'),
    P('"my first D1 offer"'),
    P('"my first Division 1 offer"'),
    P('"1st D1 offer"'),
    P('"received my first offer"'),
    P('"earned my first offer"'),
    P('"has been offered by" football', 4),
    P('"picks up an offer from"', 4),
    P('"picked up an offer from"', 4),
    P('"receives an offer from"', 4),
    P('"lands an offer from"', 4),
    P('"extends an offer to"', 4),
    P('"has offered" recruit', 3),
  ];
}

export function classJobs(now = new Date()) {
  const y = now.getUTCFullYear();
  return [y, y + 1, y + 2, y + 3, y + 4].map((c) => ({
    key: `class:${c}`,
    query: `"${c}" (offer OR offered) (QB OR RB OR WR OR TE OR OL OR DL OR LB OR DB OR ATH OR EDGE) -filter:retweets ${EXCLUDE}`,
    priority: 2,
    kind: 'class',
  }));
}

export function allJobs() {
  return [...schoolJobs(), ...phraseJobs(), ...classJobs()];
}

export function backfillAnchorDate(state, fallback = new Date()) {
  const envAnchor = process.env.OFFERWIRE_BACKFILL_ANCHOR;
  const candidate = envAnchor || state.backfillAnchorAt || state.firstRunAt;
  const parsed = candidate ? new Date(candidate) : new Date(fallback);
  const anchor = Number.isFinite(parsed.getTime()) ? parsed : new Date(fallback);
  state.backfillAnchorAt = anchor.toISOString();
  return anchor;
}

export function backfillJobs(
  days = 30,
  now = new Date(),
  chunkDays = Number(process.env.OFFERWIRE_BACKFILL_CHUNK_DAYS || days),
) {
  const count = Math.max(0, Math.floor(Number(days) || 0));
  if (!count) return [];
  const chunk = Math.max(1, Math.min(count, Math.floor(Number(chunkDays) || count)));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 86400e3;
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const schools = schoolJobs();
  const jobs = [];
  for (let ago = count; ago > 0; ago -= chunk) {
    const start = date(today - ago * day);
    const end = date(today - Math.max(0, ago - chunk) * day);
    for (const school of schools) {
      jobs.push({
        key: `backfill:v2:${school.key}:${start}:${end}`,
        query: `${school.query} since:${start} until:${end}`,
        priority: 0,
        kind: 'backfill',
        fixedWindow: true,
        schoolId: school.key,
        start,
        end,
        chunkDays: Math.round((new Date(end) - new Date(start)) / day),
      });
    }
  }
  return jobs;
}

export function backfillProgress(plan, marks = {}) {
  const completedWindows = plan.filter((j) => marks[j.key]?.completed).length;
  const totalWindows = plan.length;
  const remainingWindows = totalWindows - completedWindows;
  return {
    chunkDays: plan[0]?.chunkDays || 0,
    totalWindows,
    completedWindows,
    remainingWindows,
    totalTeamDays: totalWindows,
    completedTeamDays: completedWindows,
    remainingTeamDays: remainingWindows,
  };
}

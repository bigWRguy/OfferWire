// Offline correctness check for the deterministic layers: school resolution, the
// offer/not-offer classifier, and player identity. No network, no LLM, no API key.
//
// These cases are written from the phrasings that actually dominate offer posts,
// including the ones that historically produce FALSE positives — commitment posts,
// offer-list recaps, hypotheticals and walk-on offers. A rules layer that passes only
// the happy path is worthless, so most of the value here is in the negatives.
import { findSchools } from '../src/resolve/schools.js';
import { classify, findClassYear, findPosition, findNameCandidates, findTaggedRecruit, findReportedName } from '../src/extract/rules.js';
import { nameKey, fuzzyKey, canMerge, parseBio, looksLikeRecruit } from '../src/resolve/players.js';
import { backfillJobs, schoolJobs } from '../src/collect/queries.js';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const ids = (text) => findSchools(text).filter((s) => s.id).map((s) => s.id).sort();

console.log('school resolution');
t('handle beats everything', ids('Blessed to receive an offer from @GamecockFB').includes('south-carolina'));
t('full name', ids('Ohio State has offered 2028 ATH Marcus Lee').includes('ohio-state'));
t('two-word school not truncated',
  ids('Michigan State has offered him') .includes('michigan-state') && !ids('Michigan State has offered him').includes('michigan'),
  JSON.stringify(ids('Michigan State has offered him')));
t('hashtag camelCase split', ids('Blessed to receive an offer #RollTide').includes('alabama'));
t('nickname alias', ids('Ole Miss has extended an offer').includes('ole-miss'));
t('abbreviation', ids('LSU has offered 2027 WR Jaylen Carter').includes('lsu'));
t('ambiguous USC not silently guessed', !ids('USC offered him today').length,
  JSON.stringify(ids('USC offered him today')));
t('ambiguous resolved by co-mention', ids('USC (@uscfb) offered him today').includes('usc'));
t('ambiguous Miami not guessed', !ids('Miami has offered').length);
t('bare nickname Tigers not guessed', !ids('Tigers have offered him').length);
t('no false school in plain text', !ids('He had a great game on Friday night').length,
  JSON.stringify(ids('He had a great game on Friday night')));

console.log('offer classification');
const POS = [
  'Blessed to receive an offer from the University of Alabama! @AlabamaFTBL',
  'After a great conversation with @CoachDrink I am blessed to receive an offer from @GamecockFB',
  'AGTG! Extremely blessed to receive my 4th D1 offer from @HawkeyeFootball',
  'BREAKING: 2028 four-star ATH Marcus Lee has been offered by Georgia',
  'Ohio State has offered 2027 QB Tyler Simmons',
  'NEWS: 2029 OL Jamal Peters picks up an offer from @TexasFootball',
];
for (const p of POS) {
  const c = classify(p);
  t(`positive: ${p.slice(0, 46)}...`, !!c.kind && !c.hardNegative && c.prior > 0.3, JSON.stringify(c));
}

const NEG = [
  'Committed! Blessed to announce I am committing to Alabama',
  'He has decommitted from LSU after receiving an offer in June',
  'Top 5! Blessed to announce my top schools after 30 offers',
  'His offer list includes Alabama, Georgia, LSU and Texas',
  'Blessed to receive a preferred walk-on offer from Iowa',
  'On this day in 2019, Alabama offered him',
  'Should Georgia offer this kid? He has been dominant',
  'Signed! Officially a member of the Texas Longhorns',
];
for (const n of NEG) {
  const c = classify(n);
  t(`negative: ${n.slice(0, 46)}...`, c.hardNegative || c.prior <= 0.3, JSON.stringify(c));
}

console.log('field extraction');
t('class year', findClassYear('2028 ATH Marcus Lee has been offered', 2026) === 2028);
t('class year ignores past', findClassYear('Since 2019 he has been dominant', 2026) === null);
t('position', findPosition('2027 QB Tyler Simmons') === 'QB');
t('name candidate found', findNameCandidates('BREAKING: Marcus Lee has been offered by Georgia').some((n) => n.name === 'Marcus Lee'));
t('stopwords not names', !findNameCandidates('Blessed To Receive An Offer').some((n) => /Blessed/.test(n.name)));

console.log('player identity');
t('nickname fold', nameKey('Mike Johnson') === nameKey('Michael Johnson'));
t('suffix stripped', nameKey('Marcus Lee Jr.') === nameKey('Marcus Lee'));
t('vowel-spelling fold', fuzzyKey('Jayden Thomas') === fuzzyKey('Jaiden Thomas'));
t('different names do not fold', fuzzyKey('Marcus Lee') !== fuzzyKey('Marcus Reed'));

const A = { name: 'Marcus Lee', classYear: 2028, state: 'GA', handle: null, highSchool: null, position: 'ATH' };
t('same name + same class merges', canMerge(A, { name: 'Marcus Lee', classYear: 2028 }).merge);
t('class conflict blocks merge', !canMerge(A, { name: 'Marcus Lee', classYear: 2027 }).merge);
t('state conflict blocks merge', !canMerge(A, { name: 'Marcus Lee', state: 'TX' }).merge);
t('name-only does NOT merge', !canMerge({ name: 'Marcus Lee' }, { name: 'Marcus Lee' }).merge,
  JSON.stringify(canMerge({ name: 'Marcus Lee' }, { name: 'Marcus Lee' })));
t('different HS blocks merge', !canMerge(
  { name: 'Marcus Lee', highSchool: 'Grayson' },
  { name: 'Marcus Lee', highSchool: 'Buford' },
).merge);

console.log('bio parsing');
// Every case below is a real bio that produced a WRONG field before the fix named in
// the comment. They exist to stop those specific regressions.
const B = (bio) => parseBio(bio, 2026);
// "FB" here means FOOTBALL, not fullback -> position must be WR
t('FB is not a position', B('Garces memorial high school | W189 | FB (WR and FS)|4.19 weighted gpa|').position === 'WR',
  JSON.stringify(B('Garces memorial high school | W189 | FB (WR and FS)|4.19 weighted gpa|')));
t('qualified GPA parses', B('| 4.19 weighted gpa |').gpa === 4.19);
// "NCAA ID #2507673260" was being read as the state of Idaho
t('NCAA ID is not Idaho', B('Lipscomb Academy |C/O 28| |3.41GPA|OT|6-5 275| NCAA ID #2507673260').state == null,
  String(B('Lipscomb Academy |C/O 28| |3.41GPA|OT|6-5 275| NCAA ID #2507673260').state));
t('explicit Pos: label wins', B("6'2 255|Pos:DL/LB/H|3 Sport Athlete|NCAA ID:2602827047|").position === 'DL');
t('height and weight', B("C/O 28 Cache HS ||#7|| 6'2 180|| 4.35 40").height === '6-2' && B("C/O 28 Cache HS ||#7|| 6'2 180|| 4.35 40").weight === 180);
t('class from C/O short form', B('C/O 28 Cache HS').classYear === 2028);
t('forty time', B("6'2 180 | 4.35 40").forty === 4.35);

console.log('recruit vs non-recruit');
const R = (bio) => looksLikeRecruit(bio).ok;
// A recruit crediting his coach must NOT be filtered out as a coach.
t('recruit crediting his coach is a recruit',
  R("San Antonio Brennan C/O 28| 4 star | 4.0 GPA | RB/WR/ATH | 5'11 200lbs | 40 4.4 | Head Coach @basorecoach"));
t('stat-block bio is a recruit', R("C/O 28 Cache HS ||#7|| 6'2 180|| 4.35 40"));
t('recruit who also runs track is a recruit', R('WR | 6-1 175 | Track & Field | C/O 2029'));
t('agency is not a recruit', !R('We connect high school & transfer athletes with college programs Info@x.org'));
t('other sport is not a recruit', !R('c/o 2032 basketball player @exodusnyc scholar'));
t('coach is not a recruit', !R('Head Coach at Central High | Building men'));
t('parent is not a recruit', !R('Proud mom of a 2028 athlete'));
t('beat writer is not a recruit', !R('Recruiting coverage for @Bama_247 at @247Sports'));

console.log('reporter-voice extraction (no LLM)');
const SCH = new Set(['alabamaftbl', 'georgiafootball', 'texasfootball']);
const KNOWN = new Set(['hayesfawcett3', 'brettgreenberg_']);
const tag = (mentioned) => findTaggedRecruit({ mentioned }, SCH, KNOWN);
// X supplies the display name of tagged accounts — this is what removes the need to
// guess a recruit's name out of prose.
t('tagged recruit yields handle AND name',
  tag([{ handle: 'jaymitch_1', name: 'Jayshawn Mitchell' }, { handle: 'alabamaftbl', name: 'Alabama Football' }])?.name === 'Jayshawn Mitchell');
t('school tags are not the recruit',
  tag([{ handle: 'alabamaftbl', name: 'Alabama Football' }]) === null);
t('reporter tags are not the recruit',
  tag([{ handle: 'hayesfawcett3', name: 'Hayes Fawcett' }]) === null);
t('two unknown tags is ambiguous -> no guess',
  tag([{ handle: 'kid_a', name: 'Aa Bb' }, { handle: 'kid_b', name: 'Cc Dd' }]) === null);
t('decorated display name is rejected as a name but handle kept', (() => {
  const r = tag([{ handle: 'jaymitch_1', name: 'Jayshawn Mitchell / NCAA ID 2512788693' }]);
  return r && r.handle === 'jaymitch_1' && r.name === null;
})());

const rn = (s) => findReportedName(s);
t('name before offer verb', rn('BREAKING: 2028 four-star ATH Marcus Lee has been offered by Georgia') === 'Marcus Lee', String(rn('BREAKING: 2028 four-star ATH Marcus Lee has been offered by Georgia')));
t('name after offer verb', rn('Ohio State has offered 2027 QB Tyler Simmons') === 'Tyler Simmons', String(rn('Ohio State has offered 2027 QB Tyler Simmons')));
t('position prefix stripped', rn('NEWS: 2029 OL Jamal Peters picks up an offer from Texas') === 'Jamal Peters', String(rn('NEWS: 2029 OL Jamal Peters picks up an offer from Texas')));
t('no name present -> null', rn('Ole Miss has extended an offer') === null, String(rn('Ole Miss has extended an offer')));
t('school name is never read as a person', rn('Alabama extends offer to 2028 No. 7 RB out of San Antonio') === null, String(rn('Alabama extends offer to 2028 No. 7 RB out of San Antonio')));

console.log('hometown vs program');
// Half the FBS is named after a state, so a recruit's hometown reads as a program and
// would file a fabricated offer row under the wrong school.
t('trailing state is a hometown, not a program',
  JSON.stringify(ids('Florida has offered 4-star 2028 WR Malachi Lee out of Loudoun Sports Academy in Leesburg, Virginia.')) === JSON.stringify(['florida']),
  JSON.stringify(ids('Florida has offered 4-star 2028 WR Malachi Lee out of Loudoun Sports Academy in Leesburg, Virginia.')));
t('school-named city before a state is a hometown',
  JSON.stringify(ids('Texas has offered a kid out of Houston, Texas')) === JSON.stringify(['texas']),
  JSON.stringify(ids('Texas has offered a kid out of Houston, Texas')));
t('that city is still a school on its own', ids('Houston has offered him').includes('houston'));
t('state school still resolves as the offerer', ids('Virginia has offered him').includes('virginia'));
t('A&M survives the guard', ids('Texas A&M has offered him').includes('texas-am'));

console.log('offer verb forms');
t('plural "offers" is a reporter voice', classify('Bama offers 2028 WR Jaylen Carter').kind === 'reporter_voice');
t('counted offers is a reporter voice', classify('Georgia offers three 2029 prospects today').kind === 'reporter_voice');
t('ranking Top 5 is not a shortlist', classify("2027 Nat'l Top 5 / 5-star Cayden Daughtry received his Hog offer").prior > 0.3);
t('my top 5 IS a shortlist', classify('Blessed to announce my top 5 schools').prior <= 0.3);

console.log('historical job generation');
const history = backfillJobs(30, new Date('2026-08-27T12:00:00Z'));
t('one daily slice per school', history.length === schoolJobs().length * 30, String(history.length));
t('oldest slice starts 30 days back', history[0]?.start === '2026-07-28', history[0]?.start);
t('newest slice ends today', history.at(-1)?.end === '2026-08-27', history.at(-1)?.end);
t('historical slices are fixed windows', history.every((j) => j.fixedWindow && / since:\d{4}-\d{2}-\d{2} until:\d{4}-\d{2}-\d{2}$/.test(j.query)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

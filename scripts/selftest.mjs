// Offline correctness check for the deterministic layers: school resolution, the
// offer/not-offer classifier, and player identity. No network, no LLM, no API key.
//
// These cases are written from the phrasings that actually dominate offer posts,
// including the ones that historically produce FALSE positives — commitment posts,
// offer-list recaps, hypotheticals and walk-on offers. A rules layer that passes only
// the happy path is worthless, so most of the value here is in the negatives.
import { findSchools, explicitNonFbsOfferTarget } from '../src/resolve/schools.js';
import { classify, findClassYear, findPosition, findNameCandidates, findTaggedRecruit, findReportedName, handleClassYear, maskAwardYears } from '../src/extract/rules.js';
import { nameKey, fuzzyKey, canMerge, parseBio, looksLikeRecruit, cleanPersonName } from '../src/resolve/players.js';
import { prefilter, rulesOnlyOffers } from '../src/pipeline.js';
import { tierOf, decorateOffers } from '../src/resolve/tiers.js';
import { backfillJobs, schoolJobs, backfillAnchorDate, phraseJobs } from '../src/collect/queries.js';
import { prioritizeJobs, SearchSession } from '../src/collect/search.js';
import { dispatchWire } from '../netlify/functions/trigger-wire.mjs';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const ids = (text) => findSchools(text).filter((s) => s.id).map((s) => s.id).sort();
const veto = (text) => explicitNonFbsOfferTarget(text);

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

// A post naming a NON-FBS institution as the offer source must not be filed against an
// FBS school that appears only as a trailing cheer. Live failure: "Blessed to receive
// an offer from Community Christian College! ... Go cyclones!" filed a fabricated Iowa
// State (P4) offer.
console.log('non-FBS offer target veto');
t('community college offer with a cheer is vetoed',
  veto('Blessed to receive an offer from Community Christian College! Go cyclones!'));
t('scholarship from a small college is vetoed',
  veto('Blessed to receive a scholarship from Santa Monica College to play football'));
t('non-FBS college "of" form is vetoed',
  veto('After a great conversation Im blessed to receive an offer from Community College of Philadelphia'));
t('Ivy League (non-FBS) is vetoed',
  veto('Blessed to receive an offer from Harvard University!'));
t('FBS "X University" is NOT vetoed',
  !veto('Blessed to receive an offer from Auburn University! War Eagle')
    && !veto('Blessed to receive an offer from Ohio State University! Go Bucks')
    && !veto('Blessed to receive an offer from Iowa State University! Go Cyclones')
    && !veto('Blessed to receive an offer from the University of Alabama! Roll Tide')
    && !veto('Blessed to receive an offer from the University of Georgia! Go Dawgs')
    && !veto('Blessed to receive an offer from Liberty University! Flames Up')
    && !veto('Blessed to receive an offer from Notre Dame University! Go Irish'));
t('a bare college mention does not veto a real FBS offer',
  !veto('Committed to Alabama. Also taking classes at Community College of Phoenix'));
t('a handle-tagged FBS offer is not vetoed', !veto('Blessed to receive an offer from @AuburnFootball War Eagle!'));

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
t('lowercase Spanish de is not defensive end', findPosition('2029 G prospect de The Villages') === null);
t('single letter in prose is not a position', findPosition('California is offering a new program') === null);
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
t('decorated display name is cleaned', cleanPersonName('Jonathan Jackson 4-star WR') === 'Jonathan Jackson');
t('ordinal decoration is removed from player name', cleanPersonName('Bruce Blanden 3rd??') === 'Bruce Blanden');
t('mistyped lowercase-L Roman suffix is normalized', cleanPersonName('Guy Vann lll') === 'Guy Vann III');
t('iam-style camel display name is cleaned', cleanPersonName('iamBraydonZeno_') === 'Braydon Zeno');
t('at-style camel display name is cleaned', cleanPersonName('@GrahamCentimole') === 'Graham Centimole');
t('ordinary Mc surname is not camel-split', cleanPersonName('Sean McDonald') === 'Sean McDonald');

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
t('class from C/ short form', B('C/28 6-3 280 RT/G').classYear === 2028);
t('class from trailing apostrophe', B("28’ 6-4 225 EDGE").classYear === 2028);
t('class apostrophe attached to school initials beats unrelated award year',
  B("MHS'27 | 2025 1st Team All State | LB").classYear === 2027);
t('two-digit height inches are not a class year', B("5'11 | 190 | LB").classYear == null);
t('past shorthand award year falls back to valid four-digit class',
  B("2029 QB | National Champions '24").classYear === 2029);
t('lowercase bio position parses', B('class of 2028 | db | 6-0 185').position === 'DB');
t('mixed-case position parses', B('C/O 2028 | 6-4 225 Edge').position === 'EDGE');
t('FS normalizes to safety', B('C/O 2028 | FS/SS | 6-1 190').position === 'S');
t('specific bio position beats generic ATH', B('3 sport ath | db | C/O 2028').position === 'DB');
t('position and class can come from structured display name', looksLikeRecruit("6'7 265 | 4.0 GPA", "Kajus Muralis 4-star '28 OT").info.position === 'OT');
t('forty time', B("6'2 180 | 4.35 40").forty === 4.35);

// Class-year precision, from live data. "Soph All State '25" is the SEASON the award
// was earned, not the recruit's class: @coltonfitz2028, whose bio read "San Ramon
// Valley 2028 | Canes National 2028 | Soph All State '25", was filed as class of 2025.
t('award shorthand never outranks the real class in the same bio',
  B("3⭐WR🏈 | San Ramon Valley 2028 | ⚾OF LHP | Canes National 2028 | 🏈Soph All State '25 | 6.26 60yrd/37.3 Vert").classYear === 2028,
  JSON.stringify(B("3⭐WR🏈 | San Ramon Valley 2028 | ⚾OF LHP | Canes National 2028 | 🏈Soph All State '25 | 6.26 60yrd/37.3 Vert")));
t('current-year award shorthand alone is not a class',
  B("6-4 280 | 1st Team All State '25").classYear == null);
t('past-team award year alone is not a class',
  B("6-4 280 | 2025 1st Team All District").classYear == null);
t('school-suffix shorthand is a class', B("Marysville HS 28 | OT DT | 6'5 300 lbs | 3.98 GPA").classYear === 2028);
t('bare "Class" + two digits is a class', B("Carthage HS | Class 28 \u2b50\u2b50 | LT | 6'5").classYear === 2028);
t('curly-quoted class is a class', B('Montour Highschool ATH \u201c29 6\u201d 170 lbs').classYear === 2029, JSON.stringify(B('Montour Highschool ATH \u201c29 6\u201d 170 lbs')));
t('school-suffix with star separator is a class', B("Murrieta Valley HS *28 | 6'6 280 OT").classYear === 2028);
t('jersey number after a school is not a class', B("Garland HS #28 | 6-2 195 WR").classYear == null);
t('line position codes parse from a bio ("RT/G" is not a fullback)',
  B("C/28 6-3 280 RT/G Cardinal Newman HS").position === 'RT');
// An all-state year in a REPORTER post must not hide the class that is also there.
t('award year in post text does not hide the real class',
  findClassYear("All-State '25 2028 ATH Marcus Lee has been offered by Georgia", 2026) === 2028);
t('award year alone in post text is not a class',
  findClassYear("Soph All State '25 has been offered", 2026) == null);

console.log('handle class year');
const HCY = (h) => handleClassYear(h, 2026);
t('handle trailing year is the class', HCY('coltonfitz2028') === 2028);
t('handle year after underscore', HCY('tyler_2028') === 2028);
t('handle with no year is not a class', HCY('jaymitch_1') == null);
t('handle stale year is not a class', HCY('coach2005') == null);

console.log('recruit vs non-recruit');
const R = (bio) => looksLikeRecruit(bio).ok;
// A recruit crediting his coach must NOT be filtered out as a coach.
t('recruit crediting his coach is a recruit',
  R("San Antonio Brennan C/O 28| 4 star | 4.0 GPA | RB/WR/ATH | 5'11 200lbs | 40 4.4 | Head Coach @basorecoach"));
t('stat-block bio is a recruit', R("C/O 28 Cache HS ||#7|| 6'2 180|| 4.35 40"));
t('recruit who also runs track is a recruit', R('WR | 6-1 175 | Track & Field | C/O 2029'));
t('agency is not a recruit', !R('We connect high school & transfer athletes with college programs Info@x.org'));
t('other sport is not a recruit', !R('c/o 2032 basketball player @exodusnyc scholar'));
// A real girls'-basketball recruit ("5'11 • 3-Guard • 3.8 GPA • ...AAU") never says the
// word "basketball", so the keyword-only sport check missed it and let an Alabama-
// Huntsville women's-hoops offer through as an Alabama football offer.
t('basketball jargon without the word "basketball" is still the wrong sport',
  !R("2028 • 5'11 • 3-Guard • 3.8 GPA • Victory Christian Academy • Duval Elite AAU"));
t('coach is not a recruit', !R('Head Coach at Central High | Building men'));
t('plain basketball guard bio rejected', !R('Class of 2027 | 6-3 guard | 3.1 GPA'));
// The Air Force search surfaced a girls' flag-football/basketball recruit ("ComboG",
// "Flag Football") whose bare title-less offer read exactly like a recruit bio. Flag
// football is a different game; a tackle recruit always names a position or a 40.
t('flag football without tackle evidence is rejected', !R("Park Hill || 3SSB Della KC || 5'9\" ComboG || CO '28 || 4.0 GPA || Basketball || Flag Football"));
t('flag football WITH tackle evidence (position) is a recruit', R("6-2 180 WR | Flag Football | C/O 2028"));
// Bare "Guard" is ambiguous — an OL position as much as a basketball one. A football
// offer post from @MaverickOwens ("5'11|175lbs|Cl-2030|ATH|Guard|To whom much is
// given") was DROPPED as "different sport" because "guard" tripped the basketball
// check and no "football" word was in the bio. Presence of any unambiguous football
// position code (ATH) settles the sport.
t('guard alongside a football position code is not basketball',
  R("5'11|175lbs|Cl-2030|ATH|Guard|To whom much is given, much is required!"),
  JSON.stringify(looksLikeRecruit("5'11|175lbs|Cl-2030|ATH|Guard|To whom much is given, much is required!")));
t('requested bio parses class 2030 and ATH',
  B("5'11|175lbs|Cl-2030|ATH|Guard").classYear === 2030 && B("5'11|175lbs|Cl-2030|ATH|Guard").position === 'ATH',
  JSON.stringify(B("5'11|175lbs|Cl-2030|ATH|Guard")));
t('plain basketball guard bio is still rejected (no football code)',
  !R('Class of 2027 | 6-3 guard | 3.1 GPA'));
t('girls basketball jargon without the word basketball is still rejected',
  !R("2028 • 5'11 • 3-Guard • 3.8 GPA • Victory Christian Academy • Duval Elite AAU"));
t('JUCO player rejected from high-school wire', !R('2027 CB | Iowa Western CC | JUCO All-American | 6-2 190'));
t('current college athlete without literal JUCO is rejected',
  !R("Navarro College 6'4|285|OL/DL Class of 25' GPA: 3.5"));
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
// A HIGHLIGHTS-style post tags the recruit AND the team account. The team rides an
// obscure handle that the handle-based filter cannot see, making the post ambiguous
// and forcing a prose fallback that picked the HIGH SCHOOL as the player. The display
// name carries the signal: a team account is never the recruit.
t('team account with obscure handle is not the recruit',
  (() => {
    const r = tag([
      { handle: 'damir_williams0', name: 'Damir Williams 2027 6\u20180 181' },
      { handle: 'ehstrojanftbl', name: 'EHigh Trojans Football' },
    ]);
    return r && r.handle === 'damir_williams0' && r.name === 'Damir Williams';
  })(),
  JSON.stringify(tag([{ handle: 'damir_williams0', name: 'Damir Williams' }, { handle: 'ehstrojanftbl', name: 'EHigh Trojans Football' }])));
t('recruit + team + coach still resolves to the recruit',
  (() => {
    const r = tag([
      { handle: 'marcuslee2028', name: 'Marcus Lee' },
      { handle: 'northsideFB', name: 'Northside Football' },
      { handle: 'coachsmith', name: 'Coach Smith' },
    ]);
    return r && r.handle === 'marcuslee2028';
  })(),
  JSON.stringify(tag([{ handle: 'marcuslee2028', name: 'Marcus Lee' }, { handle: 'northsideFB', name: 'Northside Football' }, { handle: 'coachsmith', name: 'Coach Smith' }])));
t('recruit display name with stats is not confused with a team',
  (() => {
    const r = tag([{ handle: 'jaxonflowers7', name: 'Jaxon Flowers 5 Star' }, { handle: 'vtechfb', name: 'Virginia Tech Football' }]);
    return r && r.handle === 'jaxonflowers7';
  })(),
  JSON.stringify(tag([{ handle: 'jaxonflowers7', name: 'Jaxon Flowers 5 Star' }, { handle: 'vtechfb', name: 'Virginia Tech Football' }])));

t('365-branded media tag is not a recruit',
  tag([{ handle: 'olemiss365', name: 'Ole Miss 365' }]) === null);
t('decorated display name is rejected as a name but handle kept', (() => {
  const r = tag([{ handle: 'jaymitch_1', name: 'Jayshawn Mitchell / NCAA ID 2512788693' }]);
  return r && r.handle === 'jaymitch_1' && r.name === null;
})());
// X returns some display names all-lowercase ("landon cheatum" for a profile that reads
// "Landon Cheatum"). Before the fix this failed the human-name check and the caller fell
// back to a worse name scraped out of prose ("Mount Pleasant", a place, not a person).
t('lowercase display name is re-cased and still accepted', (() => {
  const r = tag([{ handle: 'cheatumlandon', name: 'landon cheatum' }]);
  return r && r.name === 'Landon Cheatum';
})(), JSON.stringify(tag([{ handle: 'cheatumlandon', name: 'landon cheatum' }])));

console.log('rules-only player gate');
// A self-announcement with a football-context bio (Football/Track, FBU, or a 40 time)
// publishes even without a position code; a bare stat-block bio that could be
// basketball ("5'11 G/F", "6'3 CG", "6'8 F/C") must NOT.
{
  const [p] = prefilter([{
    id: 't1', author: 'karontaecm', authorName: 'Karontae Cunningham',
    authorBio: "C/O 2028 Football/Track Star | 5'11 180lb | Tyner Middle High Academy | 40 4.28",
    text: 'Blessed to receive an offer from @BCFootball #AGTG',
    createdAt: '2026-08-25T00:00:00Z',
  }]);
  const recs = rulesOnlyOffers(p);
  t('football-context self-announcement publishes with null position',
    recs.length === 1 && recs[0].position === null && recs[0].class_year === 2028,
    JSON.stringify(recs));
}
{
  const [p] = prefilter([{
    id: 't2', author: 'xavienlittleton', authorName: 'Xavien Littleton',
    authorBio: "Coffee Trojans 6'4 260 Class of 2029",
    text: 'Blessed to receive an offer from @RazorbackFB #WPS #Razorbacks',
    createdAt: '2026-08-25T00:00:00Z',
  }]);
  const recs = rulesOnlyOffers(p);
  t('bare stat-block bio without football evidence still stays in the archive',
    recs.length === 0,
    JSON.stringify(recs));
}
{
  const [p] = prefilter([{
    id: 't3', author: 'audreysims2028', authorName: 'Audrey Sims',
    authorBio: "Park Hill || 3SSB Della KC || 5'9\" ComboG || CO '28 || 4.0 GPA || Basketball",
    text: 'Blessed to receive an offer from @AF_Football!',
    createdAt: '2026-08-25T00:00:00Z',
  }]);
  const recs = rulesOnlyOffers(p);
  t('basketball self-announcement stays out of the football wire',
    recs.length === 0,
    JSON.stringify(recs));
}
// …and the class-year fallback rescues the "Marysville HS 28" / handle-2028 shape.
{
  const [p] = prefilter([{
    id: 't4', author: 'c_burris2028', authorName: 'Collin Burris 3⭐',
    authorBio: "Marysville HS 28 | OT DT | 6'5 300 lbs | 3.98 GPA",
    text: 'After a great call with Coach Trickett I\u2019m blessed to receive an offer from @WVUfootball',
    createdAt: '2026-08-25T00:00:00Z',
  }]);
  const recs = rulesOnlyOffers(p);
  t('school-suffix class shorthand + handle year publish a real recruit',
    recs.length === 1 && recs[0].class_year === 2028,
    JSON.stringify(recs));
}
// Live case: @MaverickOwens self-announced an SMU offer; his bio ("ATH | Guard") was
// rejected as basketball before the football-code fix, so no SMU row ever appeared.
{
  const [p] = prefilter([{
    id: 't5', author: 'maverickowens', authorName: 'Maverick owens',
    authorBio: "5'11|175lbs|Cl-2030|ATH|Guard|To whom much is given, much is required!",
    text: 'After a great conversation with @Thamannjr Im blessed to receive a offer from @SMUFB',
    createdAt: '2026-08-29T19:34:00Z',
  }]);
  const recs = rulesOnlyOffers(p);
  t('self-announcement with ATH-guard bio publishes to SMU',
    recs.length === 1 && recs[0].school_id === 'smu' && recs[0].class_year === 2030 && recs[0].position === 'ATH' && recs[0].player_handle === 'maverickowens',
    JSON.stringify(recs));
}
// @SMUFB is a handle surface for smu; the abbreviation and hashtag resolve too.
t('SMU resolves from handle, abbrev, name and hashtag',
  ids('blessed to receive a offer from @SMUFB').includes('smu')
    && ids('after a great conversation Im blessed to receive from SMU').includes('smu')
    && ids("this time it's #SMU").includes('smu')
    && ids('picks up another offer from Southern Methodist').includes('smu'));

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
// "Central Arkansas" (FCS), "Alabama State University" (SWAC), and "University of
// Alabama - Huntsville" (D2) all share a name with an FBS program but are not it. Each
// of these filed a real garbage row against an FBS school before the fix.
t('regional-prefix non-FBS school is not the FBS program',
  !ids('out of Mount Pleasant has been offered by Nathan Brown and Central Arkansas').includes('arkansas'),
  JSON.stringify(ids('out of Mount Pleasant has been offered by Nathan Brown and Central Arkansas')));
t('non-FBS "State University" is not the bare state FBS program',
  !ids('has received a D1 offer to Alabama State University').includes('alabama'),
  JSON.stringify(ids('has received a D1 offer to Alabama State University')));
t('real FBS "State" school still resolves (regression guard)',
  ids('Arizona State comes through with an offer').includes('arizona-state'));
t('branch campus is not the flagship',
  !ids('Blessed to receive an offer from University of Alabama - Huntsville').includes('alabama'),
  JSON.stringify(ids('Blessed to receive an offer from University of Alabama - Huntsville')));
t('Arkansas Tech is not Arkansas', !ids('offer from Arkansas Tech University').includes('arkansas'));
t('South Carolina State is not South Carolina', !ids('offer from South Carolina State').includes('south-carolina'));
t('Arkansas State Mid-South is not Arkansas State', !ids('offer from Arkansas State University Mid-South').includes('arkansas-state'));

console.log('offer verb forms');
t('plural "offers" is a reporter voice', classify('Bama offers 2028 WR Jaylen Carter').kind === 'reporter_voice');
t('counted offers is a reporter voice', classify('Georgia offers three 2029 prospects today').kind === 'reporter_voice');
t('ranking Top 5 is not a shortlist', classify("2027 Nat'l Top 5 / 5-star Cayden Daughtry received his Hog offer").prior > 0.3);
t('my top 5 IS a shortlist', classify('Blessed to announce my top 5 schools').prior <= 0.3);
// "Illinois alone offers DL tests in over 130 languages" is a reply about driver's
// licences, not football, but "offers DL" matched the acronym-after-offers pattern and
// filed a WikiLeaks reply as an Illinois recruiting offer.
t('acronym after "offers" needs a following name, not just any word',
  classify('Illinois alone offers DL tests in over 130 languages.').kind !== 'reporter_voice',
  JSON.stringify(classify('Illinois alone offers DL tests in over 130 languages.')));
t('acronym after "offers" WITH a name still classifies', classify('Bama offers OL Marcus Lee').kind === 'reporter_voice');
// "has already picked up offers from Alabama, Michigan, LSU, Florida, Georgia, Miami,
// Oregon, and many more" is a running tally, not the report of one new offer, and there
// is no single school it can honestly be attributed to.
t('multi-school offer recap is a hard negative',
  classify('has already picked up offers from Alabama, Michigan, LSU, Florida, Georgia, Miami, Oregon, and many more').hardNegative);
t('previous offer is not a new event', classify('Alabama previously offered 2029 ATH Janzen Currie').hardNegative);
t('bare commit noun is a hard negative',
  classify('West Boca 6’3 WR Jayden St. Fort (‘27) is an Eastern Michigan commit. He had offers from Florida, FSU and Miami, among others.').hardNegative);
t('historical had-offers recap is not a new event',
  classify('2027 WR Jayden St. Fort had offers from Florida, FSU and Miami, among others.').hardNegative);
t('aspirational offer is not an offer', classify('A Western Michigan offer would be amazing').hardNegative);
t('recent-offer recap is not a new event', classify('He added a recent offer from Washington').hardNegative);
// A HIGHLIGHTS account's recap filed "Evans High School" as the recruit offered by Sam
// Houston (the only one of three named schools that resolved confidently). "has offers
// from X, Y, Z, & More" is existing inventory with no new-offer verb — it must be fatal
// even when just one school resolves, and even when the list starts with "The" (which
// evades the comma-list rule).
t('"has offers from X, Y, Z" recap is a hard negative',
  classify("Damir Williams @damir_williams0 - c/o 2027 - WR - Evans High School @EHSTrojanFTBL - Full Season Highlights Jr Szn (He Has Offers From The UNC Pembroke Braves, Florida Atlantic Owls, Sam Houston Bearkats, & More)").hardNegative);
t('"has offers from" without a new-offer verb is a hard negative',
  classify('He has offers from Alabama and Georgia.').hardNegative);
t('a new offer with a recap tail still survives classification',
  classify("After a great conversation I'm blessed to receive an offer from @GamecockFB! Now I have offers from Alabama, Georgia and LSU.").kind === 'player_voice',
  JSON.stringify(classify("After a great conversation I'm blessed to receive an offer from @GamecockFB! Now I have offers from Alabama, Georgia and LSU.")));
t('high school name is never read as a person',
  rn("Damir Williams - c/o 2027 - WR - Evans High School - Full Season Highlights Jr Szn (He Has Offers From The UNC Pembroke Braves)") === null,
  String(rn("Damir Williams - c/o 2027 - WR - Evans High School - Full Season Highlights Jr Szn (He Has Offers From The UNC Pembroke Braves)")));
t('explicit D2 offer is not attributed to an FBS school from search context',
  classify("I'm blessed to announce I have received a D2 offer to play running back at Minot State!").hardNegative);
t('explicit baseball offer is not a football offer',
  classify('I am thrilled to receive an offer to play baseball at The University of Akron!').hardNegative);
t('holding one D1 offer is still a stale profile statement',
  classify('2027 OT Paul Wallace holds a #D1 offer from Wyoming.').hardNegative);
t('profile label after sentence is not part of reporter player name',
  findReportedName('Nebraska offers 2028 OT Vincent Shields. Profile: link') === 'Vincent Shields');
t('reporter grammar recovers recruit when a media tag is ignored',
  findReportedName('Ole Miss offers 2030 DE Amarie Trammell - Ole Miss 365') === 'Amarie Trammell');
t('holding multiple offers is a stale profile recap',
  classify('Dieter Weber is a Class of 2028 quarterback who holds Division I offers from Miami and UConn.').hardNegative);
t('offer attributed to a prior spring showcase is stale',
  classify('Israel received his first Division I scholarship offer from Kent State following a strong spring showcase.').hardNegative);
t('offer attributed to a prior evaluation period is stale',
  classify('Jordan landed an offer from Nebraska during the spring evaluation period and has set his first visit.').hardNegative);
t('offer attributed to an earlier season is stale',
  classify('His potential gained recognition during the summer when he earned his first Division I scholarship offer from Miami.').hardNegative);
t('unrelated seasonal phrase does not suppress a current offer',
  !classify('After training during the summer, Marcus Lee has received an offer from Georgia today.').hardNegative);

console.log('offer tiers and player stats');
t('SEC school is P4', tierOf({ id: 'alabama', conference: 'SEC' }) === 'P4');
t('Big Ten is P4', tierOf({ id: 'michigan', conference: 'B1G' }) === 'P4');
t('Notre Dame (IND) is P4', tierOf({ id: 'notre-dame', conference: 'IND' }) === 'P4');
t('Mountain West is G5', tierOf({ id: 'boise-state', conference: 'MW' }) === 'G5');
t('UConn (IND) is G5', tierOf({ id: 'uconn', conference: 'IND' }) === 'G5');
// A real recruit: G5 first, P4 later. The earliest of each tier gets the milestone
// flag; the P4 one is the headline "first P4 offer".
{
  const offers = [
    { playerId: 'p1', schoolId: 'boise-state', offeredAt: '2026-07-01T00:00:00Z' },
    { playerId: 'p1', schoolId: 'troy', offeredAt: '2026-07-10T00:00:00Z' },
    { playerId: 'p1', schoolId: 'alabama', offeredAt: '2026-08-01T00:00:00Z' },
  ];
  const st = decorateOffers(offers);
  t('tiers assigned to rows', offers.every((o) => o.tier === 'G5' || o.tier === 'P4') && offers[2].tier === 'P4');
  t('first offer flagged', offers[0].firstForPlayer === true && offers[1].firstForPlayer === undefined);
  t('first P4 flagged on the Alabama row', offers[2].firstP4ForPlayer === true && offers[0].firstP4ForPlayer === undefined);
  t('first G5 flagged on the earliest G5', offers[0].firstG5ForPlayer === true);
  const s = st.get('p1');
  t('player stats total/p4/g5', s.total === 3 && s.p4 === 1 && s.g5 === 2, JSON.stringify(s));
  t('milestone timestamps', s.firstOfferAt === '2026-07-01T00:00:00Z' && s.firstP4At === '2026-08-01T00:00:00Z' && s.firstG5At === '2026-07-01T00:00:00Z', JSON.stringify(s));
}
// Idempotent: decorating the same ledger twice must not double-count flags (a rebuild
// runs decorate on freshly-built rows, but guard against re-decoration anyway).
{
  const offers = [{ playerId: 'p2', schoolId: 'alabama', offeredAt: '2026-08-01T00:00:00Z' }];
  decorateOffers(offers);
  const st = decorateOffers(offers);
  t('decorate is idempotent', offers[0].firstP4ForPlayer === true && st.get('p2').p4 === 1 && offers[0].tier === 'P4');
}

console.log('phrase job coverage');
const PJS = phraseJobs().map((j) => j.query);
t('general "blessed to receive" phrase query is present',
  PJS.some((q) => q.includes('"blessed to receive"')),
  PJS.join(' | '));
t('over-specific blessed-to-receive variants are folded into the general one',
  !PJS.some((q) => q.includes('"blessed to receive an offer"') || q.includes('"blessed to receive my"')),
  PJS.join(' | '));
t('other player-voice phrasings remain individual queries',
  PJS.some((q) => q.includes('"after a great conversation"')) && PJS.some((q) => q.includes('"AGTG"')),
  PJS.join(' | '));

console.log('historical job generation');
const history = backfillJobs(30, new Date('2026-08-27T12:00:00Z'));
t('one efficient month window per school by default', history.length === schoolJobs().length, String(history.length));
t('oldest slice starts 30 days back', history[0]?.start === '2026-07-28', history[0]?.start);
t('newest slice ends today', history.at(-1)?.end === '2026-08-27', history.at(-1)?.end);
t('historical keys are versioned away from incomplete daily plan', history.every((j) => j.key.startsWith('backfill:v2:')));
const weeklyHistory = backfillJobs(30, new Date('2026-08-27T12:00:00Z'), 7);
t('optional weekly chunks cover every school five times', weeklyHistory.length === schoolJobs().length * 5, String(weeklyHistory.length));
t('weekly chunks cover exactly 30 days',
  weeklyHistory.filter((j) => j.schoolId === schoolJobs()[0].key).reduce((n, j) => n + j.chunkDays, 0) === 30);
t('historical slices are fixed windows', history.every((j) => j.fixedWindow && / since:\d{4}-\d{2}-\d{2} until:\d{4}-\d{2}-\d{2}$/.test(j.query)));
const anchorState = { firstRunAt: '2026-08-27T12:00:00.000Z' };
t('backfill anchor starts at first run',
  backfillAnchorDate(anchorState, new Date('2026-08-30T12:00:00Z')).toISOString() === '2026-08-27T12:00:00.000Z');
t('backfill anchor does not slide on a later day',
  backfillAnchorDate(anchorState, new Date('2026-09-05T12:00:00Z')).toISOString() === '2026-08-27T12:00:00.000Z');

console.log('quota allocation');
const mixed = prioritizeJobs(
  [
    ...Array.from({ length: 8 }, (_, i) => ({ key: `live-${i}`, priority: 1 })),
    ...Array.from({ length: 8 }, (_, i) => ({ key: `history-${i}`, fixedWindow: true })),
  ],
  {},
  0.25,
);
t('25% backfill share puts one historical job in each four-job window',
  mixed.slice(0, 8).filter((j) => j.fixedWindow).length === 2,
  mixed.slice(0, 8).map((j) => j.fixedWindow ? 'H' : 'L').join(''));
t('live-only ordering does not invent history',
  prioritizeJobs([{ key: 'live', priority: 1 }], {}, 0.25).every((j) => !j.fixedWindow));

console.log('search response safety');
const fakePage = (onGoto = () => {}, onWheel = () => {}) => ({
  waitForResponse: async () => null,
  goto: async () => { onGoto(); },
  waitForTimeout: async () => {},
  url: () => 'https://x.com/search',
  mouse: { wheel: async () => { onWheel(); } },
});
const missingTimeline = new SearchSession({ authToken: 'test', ct0: 'test' });
missingTimeline.page = fakePage();
const missingResult = await missingTimeline.search('test', { settleMs: 1 });
t('missing SearchTimeline response leaves job pending',
  !missingResult.ok && /slice left pending/.test(missingResult.error), JSON.stringify(missingResult));

const emptyTimeline = new SearchSession({ authToken: 'test', ct0: 'test' });
emptyTimeline.page = fakePage(() => {
  emptyTimeline.timelineResponses = 1;
  emptyTimeline.timelineStatuses = [200];
  emptyTimeline.captured = [{}];
});
const emptyResult = await emptyTimeline.search('test', { settleMs: 1 });
t('valid parsed empty timeline can complete', emptyResult.ok && emptyResult.posts.length === 0, JSON.stringify(emptyResult));

const paginatedLimit = new SearchSession({ authToken: 'test', ct0: 'test' });
paginatedLimit.page = fakePage(
  () => {
    paginatedLimit.timelineResponses = 1;
    paginatedLimit.timelineStatuses = [200];
    paginatedLimit.captured = [{}];
  },
  () => {
    paginatedLimit.rateLimited = true;
    paginatedLimit.timelineResponses++;
    paginatedLimit.timelineStatuses.push(429);
  },
);
const limitedResult = await paginatedLimit.search('test', { scrolls: 1, settleMs: 1 });
t('pagination rate limit leaves fixed window pending',
  !limitedResult.ok && limitedResult.rateLimited && /slice left pending/.test(limitedResult.error),
  JSON.stringify(limitedResult));

console.log('scheduler fallback');
const noToken = await dispatchWire({ token: '', fetchImpl: async () => { throw new Error('must not fetch'); } });
t('Netlify trigger is inert until token is configured', noToken.skipped === 'missing GITHUB_DISPATCH_TOKEN');
let dispatchCalls = 0;
const dispatched = await dispatchWire({
  token: 'test',
  now: Date.parse('2026-08-30T01:25:00Z'),
  fetchImpl: async (_url, init = {}) => {
    dispatchCalls++;
    if (init.method === 'POST') return { ok: true, status: 204, text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }), text: async () => '' };
  },
});
t('Netlify trigger dispatches when no recent run exists', dispatched.dispatched && dispatchCalls === 2);
dispatchCalls = 0;
const skippedRecent = await dispatchWire({
  token: 'test',
  now: Date.parse('2026-08-30T01:25:00Z'),
  fetchImpl: async () => {
    dispatchCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ workflow_runs: [{ id: 123, status: 'completed', created_at: '2026-08-30T01:20:00Z' }] }),
      text: async () => '',
    };
  },
});
t('Netlify trigger suppresses a recent GitHub run', skippedRecent.runId === 123 && dispatchCalls === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

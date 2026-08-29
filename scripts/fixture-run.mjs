// Drives real offer-post text through prefilter -> rules extraction -> ledger, with no
// network and no LLM. Proves the parts that turn a post into a row: dedupe, player
// identity, corroboration counting, and earliest-post offer dating.
import { classify, findClassYear, findPosition } from '../src/extract/rules.js';
import { findSchools, byId } from '../src/resolve/schools.js';
import { indexPlayers, resolve as resolvePlayer, mergeInto } from '../src/resolve/players.js';
import { sha1 } from '../src/lib/store.js';
import { upsert } from '../src/pipeline.js';

const POSTS = [
  { id: '1', author: 'marcuslee2028', createdAt: '2026-08-25T14:00:00Z', mentions: ['georgiafootball'],
    text: 'AGTG!! Blessed to receive an offer from the University of Georgia! @GeorgiaFootball #GoDawgs' },
  // Same offer, reported a day later by a national account -> must corroborate, NOT
  // create a second row, and must NOT move the offer date forward.
  { id: '2', author: 'hayesfawcett3', createdAt: '2026-08-26T18:00:00Z', mentions: ['georgiafootball', 'marcuslee2028'],
    text: 'BREAKING: 2028 four-star ATH Marcus Lee has been offered by Georgia @GeorgiaFootball' },
  // Different school, same player -> second distinct offer row.
  { id: '3', author: 'marcuslee2028', createdAt: '2026-08-26T20:00:00Z', mentions: ['alabamaftbl'],
    text: 'Blessed to receive an offer from @AlabamaFTBL #RollTide' },
  // Commitment post -> must be rejected outright.
  { id: '4', author: 'marcuslee2028', createdAt: '2026-08-27T01:00:00Z', mentions: ['georgiafootball'],
    text: 'Committed!! 100% locked in with @GeorgiaFootball' },
  // Offer-list recap -> rejected.
  { id: '5', author: 'someaggregator', createdAt: '2026-08-27T02:00:00Z', mentions: [],
    text: 'Marcus Lee offer list: Georgia, Alabama, LSU, Texas, Ohio State' },
  // Ambiguous school with no disambiguator -> must not create a row.
  { id: '6', author: 'jaydenthomas27', createdAt: '2026-08-27T03:00:00Z', mentions: [],
    text: 'Blessed to receive an offer from USC!' },
  // Walk-on offer -> rejected.
  { id: '7', author: 'somekid', createdAt: '2026-08-27T04:00:00Z', mentions: ['hawkeyefootball'],
    text: 'Blessed to receive a preferred walk-on offer from @HawkeyeFootball' },
];

const players = [];
const offers = [];
const offerMap = new Map();
let index = indexPlayers(players);
let rejected = 0;

for (const p of POSTS) {
  const hay = `${p.text} ${p.mentions.map((m) => '@' + m).join(' ')}`;
  if (!/offer/i.test(p.text)) { rejected++; continue; }
  const c = classify(p.text);
  if (c.hardNegative || !c.kind) { rejected++; continue; }

  const schools = findSchools(hay).filter((s) => s.id && s.confidence >= 0.9);
  if (schools.length !== 1) { rejected++; continue; }
  const school = byId.get(schools[0].id);

  // Rules-only name recovery: player-voice posts belong to their author; reporter-voice
  // posts name the player in the text.
  const name = c.kind === 'player_voice' ? null : (p.text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b(?=\s+has been offered)/) || [])[1] || null;
  const incoming = {
    name, handle: c.kind === 'player_voice' ? p.author : (p.mentions.find((m) => /\d/.test(m)) || null),
    classYear: findClassYear(p.text, 2026), position: findPosition(p.text), highSchool: null, state: null,
  };

  let player = incoming.handle ? players.find((x) => x.handle === incoming.handle) : null;
  if (!player && incoming.name) player = resolvePlayer(index, incoming).player;
  if (!player) {
    player = { id: 'p_' + sha1((incoming.name || incoming.handle) + ''), ...incoming, aliases: [] };
    players.push(player);
    index = indexPlayers(players);
  } else mergeInto(player, incoming);

  const key = `${player.id}::${school.id}`;
  let o = offerMap.get(key);
  const ev = { postId: p.id, author: p.author, postedAt: p.createdAt };
  if (!o) {
    o = { playerId: player.id, schoolId: school.id, offeredAt: p.createdAt, evidence: [ev], corroborations: 1 };
    offers.push(o); offerMap.set(key, o);
  } else if (!o.evidence.some((e) => e.postId === p.id)) {
    o.evidence.push(ev);
    o.evidence.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
    o.offeredAt = o.evidence[0].postedAt;
    o.corroborations = new Set(o.evidence.map((e) => e.author)).size;
  }
}

let fail = 0;
const t = (n, c, d = '') => { if (!c) { fail++; console.log(`  FAIL ${n} ${d}`); } };

console.log('fixture ledger');
t('exactly 2 offer rows', offers.length === 2, `got ${offers.length}: ${JSON.stringify(offers.map((o) => o.schoolId))}`);
t('4 posts rejected', rejected === 4, `got ${rejected}`);
const ga = offers.find((o) => o.schoolId === 'georgia');
t('georgia offer exists', !!ga);
t('georgia corroborated by 2 authors', ga?.corroborations === 2, `got ${ga?.corroborations}`);
t('offer dated to the EARLIEST post', ga?.offeredAt === '2026-08-25T14:00:00Z', `got ${ga?.offeredAt}`);
t('alabama offer is a separate row', offers.some((o) => o.schoolId === 'alabama'));
t('one player record, not two', players.length === 1, `got ${players.length}: ${JSON.stringify(players.map((p) => [p.name, p.handle]))}`);
t('player carries name from reporter post', players[0]?.name === 'Marcus Lee', `got ${players[0]?.name}`);
t('player carries class year', players[0]?.classYear === 2028, `got ${players[0]?.classYear}`);
t('ambiguous USC produced no row', !offers.some((o) => o.schoolId === 'usc' || o.schoolId === 'south-carolina'));
t('walk-on produced no row', !offers.some((o) => o.schoolId === 'iowa'));

// This exercises the REAL upsert() from src/pipeline.js, not the fixture's own inline
// reimplementation above. Live failure: two posts about the same brand-new recruit
// ("Chase Lumpkin", class 2027) arriving in the SAME run — his own announcement plus a
// reporter's corroboration in different words — created two player records instead of
// one, because db._index was only rebuilt after the whole batch, not as each new player
// was inserted. The fixture's own inline loop rebuilds its index after every insert
// (line 62 above) and could never have caught this; only the real function can.
{
  const db2 = {
    players: [], offers: [], review: [],
    offerMap: new Map(), _index: indexPlayers([]), _new: [], newOffers: [],
  };
  const postA = { id: 'a1', author: 'chaselumpkin1', authorBio: null, text: 'x', createdAt: '2026-08-27T10:00:00Z' };
  const postB = { id: 'a2', author: 'reporter1', authorBio: null, text: 'x', createdAt: '2026-08-27T10:05:00Z' };
  upsert(db2, { player_name: 'Chase Lumpkin', player_handle: 'chaselumpkin1', school_id: 'arkansas', class_year: 2027, position: null, high_school: null, state: null }, postA, 0.45);
  upsert(db2, { player_name: 'Chase Lumpkin', player_handle: null, school_id: 'arkansas', class_year: 2027, position: 'C', high_school: null, state: null }, postB, 0.5);
  t('same-run duplicate merges into one player, not two', db2.players.length === 1,
    `got ${db2.players.length}: ${JSON.stringify(db2.players.map((p) => [p.name, p.handle, p.classYear]))}`);
}

console.log(fail ? `\n${fail} failed` : '\nall fixture assertions passed');
process.exit(fail ? 1 : 0);

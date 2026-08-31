import assert from 'node:assert/strict';
import { resolveOfferTarget } from '../src/resolve/attribution.js';
import { liveWindowQuery, advanceLiveWindow } from '../src/collect/search.js';
const p = (text, mentioned = []) => ({ text, mentioned });
for (const text of [
  'Brayden Atwood received an offer from SEMO Redhawks. Go Miami RedHawks!',
  'Blessed to receive an offer from Community Christian College. Go Cyclones!',
  'Offer from Calhoun softball Warhawks',
  'Offer from Wisconsin River Falls', 'Offer from Wisconsin Lutheran College',
  'Offer from Eastern New Mexico', 'Offer from Chattanooga',
]) assert.equal(resolveOfferTarget(p(text)).status, 'rejected', text);
assert.equal(resolveOfferTarget(p('Blessed to receive an offer from @RFootball', [{handle:'RFootball', name:'Rutgers Football'}])).schoolId, 'rutgers');
assert.equal(resolveOfferTarget(p('Blessed to receive an offer from @CanesFootball', [{handle:'CanesFootball', name:'Miami Hurricanes Football'}])).schoolId, 'miami');
const cache={accounts:{coachx:{handle:'coachx', affiliationType:'coach', fbsSchoolId:'virginia', expiresAt:'2099-01-01T00:00:00Z'}}};
assert.equal(resolveOfferTarget(p('After a great talk, I received an offer from @CoachX', [{handle:'coachx',name:'Coach X'}]),cache).schoolId,'virginia');
assert.equal(resolveOfferTarget(p('Blessed to receive an offer from @Unknown', [{handle:'unknown',name:'Unknown'}])).status,'pending');
const mark={at:'2026-08-31T00:00:00.000Z'}; const w=liveWindowQuery({query:'offer'},mark,Date.parse('2026-08-31T02:00:00Z'),0);
assert.match(w.query,/since_time:.*until_time:/); assert.equal(advanceLiveWindow(mark,w.window,[{createdAt:'2026-08-31T01:00:00Z'}],true),false); assert.ok(mark.window);
const q2=liveWindowQuery({query:'offer'},mark,Date.parse('2026-08-31T03:00:00Z'),0); assert.equal(q2.window.upper,w.window.upper); assert.ok(new Date(q2.window.until_time)<new Date(w.window.until_time));
assert.equal(advanceLiveWindow(mark,q2.window,[],false),true); assert.equal(mark.at,w.window.upper); console.log('reliability assertions passed');

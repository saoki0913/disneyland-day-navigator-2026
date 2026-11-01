import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as DL from '../public/js/parks/dl.js';
import * as DCA from '../public/js/parks/dca.js';
import { defaultParkFor, PARK_ID } from '../public/js/data.js';
import { normalizeTPWLive, normalizeQT, normalizeChildren, normalizeSchedule, matchId, parkFrom } from '../lib/server.js';

for (const [name, P] of [['dl', DL], ['dca', DCA]]) {
  test(`${name}: catalog is internally consistent`, () => {
    for (const a of P.ATTRACTIONS) {
      assert.ok(P.landById[a.land], `${a.id} land ${a.land}`);
      assert.ok(a.pos && a.dur > 0 && a.peak > 0 && a.match.length, a.id);
    }
    for (const r of P.RESTAURANTS) assert.ok(P.landById[r.land], `${r.id} land`);
    for (const id of Object.keys(P.DEFAULT_MUST)) assert.ok(P.attractionById[id], `must ${id}`);
    for (const id of Object.keys(P.PRIORITY)) assert.ok(P.attractionById[id], `priority ${id}`);
    for (const plan of Object.values(P.PLANS)) {
      for (const m of plan.meals) assert.ok(P.restaurantById[m.restaurant], `${plan.id} ${m.id} → ${m.restaurant}`);
      for (const s of Object.keys(plan.shows)) assert.ok(P.showById[s], `${plan.id} show ${s}`);
    }
    // ids are unique and match patterns don't collide inside the park
    assert.equal(new Set(P.ATTRACTIONS.map((a) => a.id)).size, P.ATTRACTIONS.length);
    for (const a of P.ATTRACTIONS) assert.equal(matchId(a.en, P.ATTRACTIONS), a.id, `${a.en} matches itself`);
  });
}

test('dca: しおり defaults (11/1, 8:00–21:00, dinner 18:30, Radiator Springs must)', () => {
  assert.equal(DCA.TRIP.date, '2026-11-01');
  assert.equal(DCA.TRIP.openMin, 480);
  assert.equal(DCA.TRIP.closeMin, 1260);
  assert.deepEqual(DCA.DEFAULT_MUST, { rsr: true });
  for (const p of Object.values(DCA.PLANS)) assert.equal(p.meals.find((m) => m.id === 'dinner').at, 18 * 60 + 30);
});

test('default park follows the trip dates; server/Node default stays Disneyland', () => {
  assert.equal(defaultParkFor('2026-10-30'), 'dl');
  assert.equal(defaultParkFor('2026-10-31'), 'dl');
  assert.equal(defaultParkFor('2026-11-01'), 'dca');
  assert.equal(PARK_ID, 'dl');
});

test('server: ?park=dca selects California Adventure, anything else Disneyland', () => {
  assert.equal(parkFrom('https://x/api/live?park=dca').PARK.id, 'dca');
  assert.equal(parkFrom('https://x/api/live').PARK.id, 'dl');
  assert.equal(parkFrom('https://x/api/live?park=zzz').PARK.id, 'dl');
});

test('server: DCA live / Queue-Times / coords normalisation', () => {
  const live = { liveData: [
    { name: 'Radiator Springs Racers', entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 75 }, SINGLE_RIDER: { waitTime: 20 } } },
    { name: 'Guardians of the Galaxy - Mission: BREAKOUT!', entityType: 'ATTRACTION', status: 'DOWN', queue: { STANDBY: { waitTime: null } } },
    { name: "Soarin' Around the World", entityType: 'ATTRACTION', status: 'OPERATING', queue: { STANDBY: { waitTime: 30 } } },
    { name: 'World of Color', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ startTime: '2026-11-01T20:30:00-08:00', endTime: '2026-11-01T20:55:00-08:00' }] },
  ] };
  const n = normalizeTPWLive(live, DCA);
  assert.equal(n.attractions.rsr.wait, 75);
  assert.equal(n.attractions.rsr.single, 20);
  assert.equal(n.attractions.guardians.status, 'DOWN');
  assert.equal(n.attractions.soarin.wait, 30);
  assert.deepEqual(n.shows.worldofcolor.times.map((t) => t.start), [20 * 60 + 30]);
  assert.equal(n.shows.worldofcolor.times[0].date, '2026-11-01');
  // Disneyland's catalog does not pick up DCA rides
  assert.equal(normalizeTPWLive(live).matched, 0);
  const q = normalizeQT({ lands: [{ rides: [{ name: 'Incredicoaster', is_open: true, wait_time: 35 }] }] }, DCA);
  assert.equal(q.attractions.incredicoaster.wait, 35);
  const c = normalizeChildren({ children: [
    { name: 'Radiator Springs Racers', entityType: 'ATTRACTION', location: { latitude: 33.8045, longitude: -117.9180 } },
    { name: 'Space Mountain', entityType: 'ATTRACTION', location: { latitude: 33.8118, longitude: -117.9176 } },
  ] }, DCA);
  assert.deepEqual(Object.keys(c), ['rsr']);
});

test('server: schedule keeps every date so the client can follow a changed trip date', () => {
  const s = normalizeSchedule({ schedule: [
    { date: '2026-11-01', type: 'OPERATING', openingTime: '2026-11-01T08:00:00-08:00', closingTime: '2026-11-01T21:00:00-08:00' },
    { date: '2026-11-02', type: 'OPERATING', openingTime: '2026-11-02T09:00:00-08:00', closingTime: '2026-11-02T20:00:00-08:00' },
  ] }, '2026-11-01');
  assert.equal(s.operating.close, 21 * 60);
  assert.equal(s.days['2026-11-02'].operating.open, 9 * 60);
});

test('dca photo sets exist for every set the app requests', async () => {
  const { PHOTO_QUERIES, PHOTO_QUERIES_DCA } = await import('../lib/server.js');
  for (const set of Object.keys(PHOTO_QUERIES)) assert.ok(PHOTO_QUERIES_DCA[set], `dca set ${set}`);
  for (const id of Object.keys(PHOTO_QUERIES_DCA.rides)) assert.ok(DCA.attractionById[id], `photo for unknown ride ${id}`);
  for (const id of Object.keys(PHOTO_QUERIES_DCA.food)) assert.ok(DCA.restaurantById[id.replace(/^food_/, '')], `photo for unknown shop ${id}`);
});

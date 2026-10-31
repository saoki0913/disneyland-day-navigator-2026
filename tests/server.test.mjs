import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTPWLive, normalizeQT, normalizeChildren, normalizeSchedule, localMinutes, matchId } from '../lib/server.js';
import { ATTRACTIONS } from '../public/js/data.js';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

test('ThemeParks.wiki live → our ids, statuses and waits', () => {
  const n = normalizeTPWLive(fx('tpw-live.json'));
  assert.ok(n.matched >= 20);
  assert.equal(n.attractions.rise.status, 'DOWN');
  assert.equal(n.attractions.rise.wait, null);
  assert.equal(n.attractions.indy.wait, 25);          // "Indiana Jones™ Adventure" (™) matched
  assert.equal(n.attractions.falcon.single, 15);
  assert.equal(n.attractions.smallworld.status, 'REFURBISHMENT');
  assert.equal(n.attractions.pirates.wait, 20);       // not confused with "Pirate's Lair"
  assert.deepEqual(n.shows.fantasmic.times.map((t) => t.start), [21 * 60, 22 * 60 + 30]);
  assert.equal(n.shows.fireworks.times[0].start, 21 * 60 + 30);
  assert.equal(n.otherShows[0].name, 'Main Street Philharmonic');
});

test('Queue-Times fallback', () => {
  const n = normalizeQT(fx('qt.json'));
  assert.equal(n.attractions.space.wait, 40);
  assert.equal(n.attractions.rise.status, 'CLOSED');
  assert.equal(n.attractions.rise.wait, null);
});

test('children coords: only in-park, matched', () => {
  const c = normalizeChildren(fx('tpw-children.json'));
  assert.equal(c.rise.lat, 33.81548);
  assert.equal(c.plazainn.lon, -117.91843);
  assert.equal(Object.keys(c).length, 2);
});

test('schedule picks OPERATING for 10/31', () => {
  const s = normalizeSchedule(fx('tpw-schedule.json'));
  assert.equal(s.operating.open, 480);
  assert.equal(s.operating.close, 1380);
  assert.equal(s.extra[0].description, 'Early Entry');
});

test('localMinutes handles offsets and UTC', () => {
  assert.equal(localMinutes('2026-10-31T21:00:00-07:00'), 1260);
  assert.equal(localMinutes('2026-11-01T04:00:00Z'), 1260); // 21:00 PDT
});

test('every attraction has a unique matcher', () => {
  const names = { rise: 'Star Wars: Rise of the Resistance', haunted: 'Haunted Mansion Holiday', thunder: 'Big Thunder Mountain Railroad', mmrr: "Mickey & Minnie's Runaway Railway", toad: "Mr. Toad's Wild Ride", startours: 'Star Tours – The Adventures Continue' };
  for (const [id, name] of Object.entries(names)) assert.equal(matchId(name, ATTRACTIONS), id);
});

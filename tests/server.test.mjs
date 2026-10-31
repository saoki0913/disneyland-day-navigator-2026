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

import { pickCommons, PHOTO_QUERIES } from '../lib/server.js';
const ii = (w, h, mime = 'image/jpeg', extra = {}) => [{ url: 'https://upload.wikimedia.org/x.jpg', thumburl: 'https://upload.wikimedia.org/thumb/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x.jpg', width: w, height: h, mime, extmetadata: { Artist: { value: '<a href="#">Jane Doe</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } }, ...extra }];
test('Commons picker: rejects other parks, logos, small, non-matching; prefers Disneyland', () => {
  const pages = [
    { index: 1, title: 'File:Space Mountain Magic Kingdom.jpg', imageinfo: ii(2000, 1500) },
    { index: 2, title: 'File:Space Mountain logo.svg', imageinfo: ii(800, 800, 'image/svg+xml') },
    { index: 3, title: 'File:Tomorrowland at night.jpg', imageinfo: ii(2000, 1500) },
    { index: 4, title: 'File:Space Mountain small.jpg', imageinfo: ii(300, 200) },
    { index: 5, title: 'File:Space Mountain entrance.jpg', imageinfo: ii(1600, 1200) },
    { index: 6, title: 'File:Space Mountain Disneyland 2019.jpg', imageinfo: ii(1600, 1200) },
  ];
  const r = pickCommons(pages, PHOTO_QUERIES.rides.space[1]);
  assert.equal(r.title, 'Space Mountain Disneyland 2019.jpg');
  assert.equal(r.author, 'Jane Doe');
  assert.equal(r.license, 'CC BY-SA 4.0');
  assert.equal(pickCommons([{ index: 1, title: 'File:Tokyo Disneyland Space Mountain.jpg', imageinfo: ii(2000, 1500) }], PHOTO_QUERIES.rides.space[1]), null);
});
test('photo sets stay under the 50-subrequest free-plan limit (incl. Wikipedia fallbacks)', () => {
  for (const [set, q] of Object.entries(PHOTO_QUERIES)) assert.ok(Object.keys(q).length * 2 <= 50, set);
});

// ---------- shared plan (two phones) ----------
import { mergeDocs, newCode, CODE_RE } from '../public/js/share.js';
import { handleShareGet, handleSharePost } from '../lib/share-server.js';
test('share: merge is a union of done records, undo wins only when newer, settings last-writer-wins', () => {
  const a = { done: { space: 100, rise: 200 }, doneMin: { space: 600, rise: 640 }, doneDel: {}, f: { plan: { at: 10, v: 'relax' }, order: { at: 50, v: ['indy'] } } };
  const b = { done: { haunted: 150 }, doneMin: { haunted: 620 }, doneDel: { rise: 300 }, f: { plan: { at: 20, v: 'rides' } } };
  const m = mergeDocs(a, b);
  assert.deepEqual(Object.keys(m.done).sort(), ['haunted', 'space']);
  assert.equal(m.f.plan.v, 'rides');
  assert.deepEqual(m.f.order.v, ['indy']);
  assert.deepEqual(mergeDocs(a, b), mergeDocs(b, a), 'commutative');
  assert.deepEqual(mergeDocs(m, m), m, 'idempotent');
  const redo = mergeDocs(m, { done: { rise: 400 }, doneMin: { rise: 700 } });
  assert.equal(redo.done.rise, 400, 'done again after undo');
  assert.ok(CODE_RE.test(newCode()));
});
test('share API: two phones converge through the KV room', async () => {
  const store = new Map();
  const env = { SHARE: { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v); } } };
  const ctx = (method, body) => ({ params: { code: 'abcd2345' }, env, request: new Request('https://x/api/share/abcd2345', { method, body: body ? JSON.stringify(body) : undefined }) });
  let r = await (await handleShareGet(ctx('GET'))).json();
  assert.equal(r.exists, false);
  await handleSharePost(ctx('POST', { doc: { done: { space: 1 }, doneMin: { space: 600 }, f: { plan: { at: 5, v: 'rides' } } } }));
  r = await (await handleSharePost(ctx('POST', { doc: { done: { indy: 2 }, doneMin: { indy: 630 } } }))).json();
  assert.deepEqual(Object.keys(r.doc.done).sort(), ['indy', 'space']);
  assert.equal(r.doc.f.plan.v, 'rides');
  const bad = await handleShareGet({ ...ctx('GET'), params: { code: '../x' } });
  assert.equal(bad.status, 400);
  const off = await handleShareGet({ ...ctx('GET'), env: {} });
  assert.equal(off.status, 503);
});

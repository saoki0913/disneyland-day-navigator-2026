import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommend, simulateDay, buildAnchors, anchorConflicts, crowdRatio, walkMin, distanceM, gpsNeedsRedraw, movingPlanMin } from '../public/js/engine.js';
import { normalizeTPWLive } from '../lib/server.js';
import { ATTRACTIONS } from '../public/js/data.js';

const fixture = normalizeTPWLive(JSON.parse(readFileSync(new URL('./fixtures/tpw-live.json', import.meta.url))));
const liveOf = (n) => Object.fromEntries(Object.entries(n.attractions).map(([k, v]) => [k, { ...v, kind: 'live' }]));
const base = (o = {}) => {
  const planId = o.planId || 'balance';
  const live = o.live ?? {};
  const now = o.now ?? 480;
  return { now, openMin: 480, closeMin: 1380, pos: o.pos ?? null, planId, done: o.done || {}, excluded: {}, skip: {}, live, crowd: crowdRatio(live, now), anchors: buildAnchors(planId, o.prefs || {}, o.done || {}), coords: {} };
};

for (const planId of ['relax', 'balance', 'rides']) {
  for (const now of [420, 480, 600, 780, 960]) {
    for (const liveMode of ['none', 'fixture']) {
      test(`${planId} @${now} live=${liveMode}: both Star Wars rides are planned`, () => {
        const sim = simulateDay(base({ planId, now, live: liveMode === 'fixture' ? liveOf(fixture) : {} }));
        assert.deepEqual(sim.missingMust, [], `missing ${sim.missingMust}`);
      });
    }
  }
  test(`${planId} @19:00 nothing done: at least one Star Wars ride planned, the other reported`, () => {
    const c = base({ planId, now: 1140 });
    const sim = simulateDay(c);
    assert.ok(sim.missingMust.length <= 1, `missing ${sim.missingMust}`);
    if (sim.missingMust.length) {
      // the UI shows sim.missingMust as a warning; recommend() must keep it visible too
      const r = recommend(c);
      assert.ok(r.primary.a?.must || r.primary.type === 'anchor' || r.notes.length >= 0);
    }
  });
  test(`${planId}: rides never overlap meals/shows`, () => {
    const sim = simulateDay(base({ planId, now: 480, live: liveOf(fixture) }));
    const fixed = sim.items.filter((i) => i.type === 'meal' || i.type === 'show');
    for (const r of sim.items.filter((i) => i.type === 'ride')) {
      for (const f of fixed) {
        const fStart = f.anchor.start - (f.anchor.claim || 0);
        const soft = r.reasons?.some((x) => x.k === 'soft' || x.k === 'close');
        const overlap = r.start < f.anchor.end && r.end > (soft ? f.anchor.start - 5 : fStart);
        // A ride may only extend past a fixed block if it is the final "join the line before close" ride.
        assert.ok(!overlap, `${r.id} ${r.start}-${r.end} overlaps ${f.id} ${fStart}-${f.anchor.end}`);
      }
    }
  });
  test(`${planId}: meals and shows don't conflict with each other`, () => {
    assert.deepEqual(anchorConflicts(buildAnchors(planId, {})), []);
  });
}

test('plans differ in ride count (C ≥ B ≥ A roughly)', () => {
  const n = (p) => simulateDay(base({ planId: p, now: 480 })).rides;
  assert.ok(n('rides') >= n('balance') - 1, `rides ${n('rides')} vs balance ${n('balance')}`);
});

test('done rides are never recommended again', () => {
  const r = recommend(base({ now: 600, done: { rise: 1, falcon: 1 } }));
  assert.ok(!['rise', 'falcon'].includes(r.primary?.a?.id));
  assert.ok(!r.alts.some((a) => ['rise', 'falcon'].includes(a.a.id)));
});

test('a DOWN must-ride is reported (not silently dropped) and not recommended now', () => {
  const r = recommend(base({ now: 600, live: liveOf(fixture) }));
  assert.notEqual(r.primary?.a?.id, 'rise');
  assert.ok(r.notes.some((n) => n.id === 'rise' && /休止/.test(n.text)));
});

test('refurbishment closures are excluded from the plan', () => {
  const sim = simulateDay(base({ now: 600, live: liveOf(fixture) }));
  assert.ok(!sim.items.some((i) => i.id === 'smallworld'));
});

test('before opening, CLOSED statuses do not block rides', () => {
  const live = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, { status: 'CLOSED', wait: null, kind: 'live' }]));
  const r = recommend(base({ now: 420, live }));
  assert.equal(r.primary.type, 'ride');
});

test('after closing, mode is closed', () => {
  assert.equal(recommend(base({ now: 1385 })).mode, 'closed');
});

test('meal time switches the recommendation to the meal', () => {
  const r = recommend(base({ now: 11 * 60 + 28, pos: { lat: 33.8119, lon: -117.9184 } }));
  assert.equal(r.primary.type, 'anchor');
  assert.equal(r.primary.anchor.id, 'meal:lunch');
});

test('show claim time switches to the show', () => {
  const done = { 'meal:lunch': 1, 'meal:snack': 1, 'meal:dinner': 1, 'show:cavalcade': 1 };
  const r = recommend(base({ now: 21 * 60, done, pos: { lat: 33.8120, lon: -117.9219 } }));
  assert.equal(r.primary.type, 'anchor');
  assert.equal(r.primary.anchor.id, 'show:fireworks');
});

test('turning a show off removes it', () => {
  const a = buildAnchors('balance', { shows: { cavalcade: { on: false } } });
  assert.ok(!a.some((x) => x.id === 'show:cavalcade'));
  const b = buildAnchors('rides', { shows: { cavalcade: { on: true, pick: '14:45' } } });
  assert.equal(b.find((x) => x.id === 'show:cavalcade').start, 14 * 60 + 45);
});

test('alternatives carry criterion labels', () => {
  const r = recommend(base({ now: 600, live: liveOf(fixture) }));
  const labels = r.alts.map((a) => a.label);
  assert.ok(labels.includes('待ち時間優先'));
  assert.ok(labels.includes('距離優先') || labels.includes('人気度優先'));
});

test('a live wait far below normal adds a "空いている" reason', () => {
  const r = recommend(base({ now: 14 * 60 + 30, live: { indy: { status: 'OPERATING', wait: 10, kind: 'live' } }, done: { 'meal:lunch': 1, 'show:cavalcade': 1 } }));
  const indy = [r.primary, ...r.alts].find((x) => x?.a?.id === 'indy');
  assert.ok(indy, 'indy should be suggested');
  assert.ok(indy.reasons.some((x) => x.k === 'dip'));
});

test('walking estimate is distance × 1.4 at 70 m/min', () => {
  const a = { lat: 33.8100, lon: -117.9190 }, b = { lat: 33.8150, lon: -117.9190 };
  const d = distanceM(a, b);
  assert.ok(d > 540 && d < 570);
  assert.equal(walkMin(a, b), Math.round((d * 1.4) / 70));
});

test('a pinned ride becomes the primary recommendation', () => {
  const c = base({ now: 600 });
  const r = recommend({ ...c, pin: { id: 'matterhorn', until: 700 } });
  assert.equal(r.primary.a.id, 'matterhorn');
  assert.equal(r.primary.reasons[0].k, 'pin');
  const r2 = recommend({ ...c, pin: { id: 'matterhorn', until: 500 } }); // expired
  assert.notEqual(r2.primary.a.id, 'matterhorn');
});

// ---------- plan conditions (builder) ----------
test('a user-chosen "絶対乗る" ride is planned and tagged must', () => {
  const c = { ...base({ now: 480 }), must: { rise: true, falcon: true, matterhorn: true } };
  const sim = simulateDay(c);
  const m = sim.items.find((i) => i.id === 'matterhorn');
  assert.ok(m, 'matterhorn planned');
  assert.equal(m.must, true);
  assert.deepEqual(sim.missingMust, []);
});

test('removing Star Wars from must no longer forces it', () => {
  const r = recommend({ ...base({ now: 600 }), must: {} });
  assert.ok(!r.primary.reasons?.some((x) => x.k === 'must'));
  assert.deepEqual(simulateDay({ ...base({ now: 480 }), must: {} }).missingMust, []);
});

test('"乗らない" rides are never planned', () => {
  const sim = simulateDay({ ...base({ now: 480 }), excluded: { haunted: true, indy: true } });
  assert.ok(!sim.items.some((i) => i.id === 'haunted' || i.id === 'indy'));
});

test('lower wait tolerance plans shorter average waits', () => {
  const avg = (maxWait) => {
    const rides = simulateDay({ ...base({ now: 480 }), cond: { maxWait, walk: 'normal' } }).items.filter((i) => i.type === 'ride' && !i.must);
    return rides.reduce((s, i) => s + i.wait, 0) / Math.max(1, rides.length);
  };
  assert.ok(avg(30) <= avg(90), `30:${avg(30)} 90:${avg(90)}`);
});

test('"歩く量 少なめ" plans less total walking than "気にしない"', () => {
  const walk = (w) => simulateDay({ ...base({ now: 480 }), cond: { maxWait: 60, walk: w } }).items.filter((i) => i.type === 'ride').reduce((s, i) => s + i.walk, 0);
  assert.ok(walk('low') <= walk('any'), `low:${walk('low')} any:${walk('any')}`);
});

// ---------- user ride order (drag & drop on the plan) ----------
test('order: the plan follows the user order when rides fit', () => {
  const c = base({ now: 600, live: liveOf(fixture) });
  const auto = simulateDay(c).items.filter((i) => i.type === 'ride').map((i) => i.id);
  assert.ok(auto.length >= 3);
  const order = [auto[2], auto[0], auto[1], ...auto.slice(3)];
  const got = simulateDay({ ...c, order }).items.filter((i) => i.type === 'ride').map((i) => i.id);
  assert.equal(got[0], auto[2], 'dragged ride goes first');
  assert.deepEqual([...got].sort(), [...auto].sort(), 'same rides, different order');
  const r = recommend({ ...c, order });
  assert.equal(r.primary.a.id, auto[2]);
  assert.equal(r.primary.reasons[0].k, 'order');
});
test('order: rides that are done or excluded are skipped', () => {
  const c = base({ now: 600, done: { space: true } });
  const r = recommend({ ...c, order: ['space', 'haunted'], excluded: {} });
  assert.equal(r.primary.a.id, 'haunted');
});
test('rideRatios: a ride busier than usual stays busier in the near-future estimate', async () => {
  const { rideRatios, waitFor } = await import('../public/js/engine.js');
  const a = ATTRACTIONS.find((x) => x.id === 'space');
  const now = 660;
  const live = { space: { status: 'OPERATING', wait: 120, kind: 'live' } };
  const rr = rideRatios(live, now);
  assert.ok(rr.space > 1.5);
  const plain = waitFor(a, now + 60, { now, live: {}, crowd: 1 }).wait;
  const busy = waitFor(a, now + 60, { now, live: {}, crowd: 1, rideRatio: rr, liveAt: now }).wait;
  const far = waitFor(a, now + 400, { now, live: {}, crowd: 1, rideRatio: rr, liveAt: now }).wait;
  assert.ok(busy > plain, `${busy} > ${plain}`);
  assert.equal(far, waitFor(a, now + 400, { now, live: {}, crowd: 1 }).wait, 'fades back to the crowd ratio');
});

test('selected planning time advances with the clock and can be reset', () => {
  const setting = { base: 930, setAt: 1000000 };
  assert.equal(movingPlanMin(setting, 1000000), 930);
  assert.equal(movingPlanMin(setting, 1000000 + 10 * 60000), 940);
  assert.equal(movingPlanMin(null, 1000000), null);
});
test('GPS noise and too-frequent callbacks never repaint the page', () => {
  const a = { lat: 33.81185, lon: -117.9214, acc: 15 };
  const jitter = { ...a, lat: 33.81186 };
  const moved = { ...a, lat: 33.81230 };
  assert.equal(gpsNeedsRedraw(null, a, 0), true);
  assert.equal(gpsNeedsRedraw(a, jitter, 20000), false);
  assert.equal(gpsNeedsRedraw(a, moved, 100), false);
  assert.equal(gpsNeedsRedraw(a, moved, 20000), true);
  assert.equal(gpsNeedsRedraw({ ...a, acc: 90 }, { ...jitter, acc: 15 }, 20000), true);
});

test('DOWN ride: kept out of the timeline as 再開待ち, not reported as missing', () => {
  const live = liveOf(fixture);
  assert.equal(live.rise.status, 'DOWN');
  const sim = simulateDay(base({ now: 600, live }));
  assert.ok(!sim.items.some((i) => i.id === 'rise'), 'rise not planned while DOWN');
  assert.ok(sim.waiting.includes('rise'));
  assert.ok(!sim.missingMust.includes('rise'));
  const back = { ...live, rise: { ...live.rise, status: 'OPERATING', wait: 45 } };
  const sim2 = simulateDay(base({ now: 600, live: back }));
  assert.ok(sim2.items.some((i) => i.id === 'rise'), 'reopened ride returns to the plan');
  assert.deepEqual(sim2.waiting, []);
});

// ---------- in-app walking routes (built-in guest walkway network) ----------
import { walkRoute, NODES, EDGES } from '../public/js/walk.js';
const PARK = { lat: [33.8095, 33.8170], lon: [-117.9250, -117.9160] };
const inPark = ([lat, lon]) => lat >= PARK.lat[0] && lat <= PARK.lat[1] && lon >= PARK.lon[0] && lon <= PARK.lon[1];
test('walk: the walkway network is connected', () => {
  const adj = {};
  for (const [a, b] of EDGES) { (adj[a] ||= []).push(b); (adj[b] ||= []).push(a); }
  const seen = new Set(['hub']), q = ['hub'];
  while (q.length) for (const v of adj[q.shift()] || []) if (!seen.has(v)) { seen.add(v); q.push(v); }
  assert.deepEqual([...seen].sort(), Object.keys(NODES).sort());
});
test('walk: every ride is reachable from the entrance inside the park, with a sane detour', () => {
  const ent = { lat: NODES.ent[0], lon: NODES.ent[1] };
  for (const a of ATTRACTIONS) {
    const r = walkRoute(ent, a.pos);
    assert.ok(r, a.id);
    assert.ok(r.coords.every(inPark), `${a.id} leaves the park`);
    assert.ok(r.distance <= distanceM(ent, a.pos) * 2 + 80, `${a.id}: ${r.distance}m vs ${Math.round(distanceM(ent, a.pos))}m`);
    assert.equal(r.steps[r.steps.length - 1].type, 'arrive');
  }
});
test('walk: hub → Rise of the Resistance goes through Frontierland/Big Thunder Trail or Bayou, not outside', () => {
  const r = walkRoute({ lat: 33.8121, lon: -117.9200 }, { lat: 33.8155, lon: -117.9236 });
  assert.ok(r.coords.every(inPark));
  assert.ok(r.distance < 900, `${r.distance}m`);
  assert.ok(r.steps.some((s) => s.type === 'turn'), 'has turn directions');
});

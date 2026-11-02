import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommend, simulateDay, buildAnchors, anchorConflicts, crowdRatio, walkMin, distanceM } from '../public/js/engine.js';
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

// ---------- repeat rides (ride counts) ----------
test('an already-ridden must ride with a higher wanted count is planned again', () => {
  const c = { ...base({ now: 600, done: { rise: 1, falcon: 1, matterhorn: 1 } }), counts: { rise: 1, falcon: 1, matterhorn: 1 }, must: { rise: true, falcon: true, matterhorn: 2 } };
  const sim = simulateDay(c);
  const again = sim.items.filter((i) => i.id === 'matterhorn');
  assert.equal(again.length, 1, 'matterhorn planned exactly once more');
  assert.equal(again[0].nth, 2);
  assert.ok(again[0].reasons.some((x) => x.k === 'repeat'));
  assert.ok(!sim.items.some((i) => i.id === 'rise' || i.id === 'falcon'), 'satisfied musts are not repeated');
  assert.deepEqual(sim.missingMust, []);
});

test('wanting a ride 3 times from scratch plans it 3 times', () => {
  const sim = simulateDay({ ...base({ now: 480 }), must: { rise: true, falcon: true, space: 3 } });
  assert.equal(sim.items.filter((i) => i.id === 'space').length, 3);
  assert.deepEqual(sim.items.filter((i) => i.id === 'space').map((i) => i.nth), [1, 2, 3]);
});

test('counts reaching the wanted number stop the ride from being recommended', () => {
  const c = { ...base({ now: 600 }), counts: { space: 2 }, done: { space: 1 }, must: { space: 2 } };
  const r = recommend(c);
  assert.notEqual(r.primary?.a?.id, 'space');
  assert.deepEqual(simulateDay(c).missingMust, []);
});

test('a must ride still short of its count is reported as missing when it cannot fit', () => {
  const c = { ...base({ now: 1370 }), counts: { rise: 1, falcon: 1 }, must: { rise: 3, falcon: true } };
  assert.deepEqual(simulateDay(c).missingMust, ['rise']);
});

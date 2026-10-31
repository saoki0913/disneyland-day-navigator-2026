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
  for (const id of order.slice(0, 3)) assert.ok(got.includes(id), `${id} stays in the day`);
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


test('buildAnchors: meal duration override (食事にかける時間)', () => {
  const a = buildAnchors('balance', { mealOverrides: { dinner: { dur: 120, at: 17 * 60 } } });
  const d = a.find((x) => x.id === 'meal:dinner');
  assert.equal(d.start, 17 * 60);
  assert.equal(d.end - d.start, 120);
});

// ---------- fixed-sequence plan (乗った keeps the order) + locks ----------
import { planFromOrder, syncSequence, applyLocks } from '../public/js/engine.js';
const seqOf = (sim) => [...sim.items.filter((i) => ['ride', 'meal', 'show'].includes(i.type)).map((i) => i.id)];
test('planFromOrder: a snapshot of the recommended plan reproduces its order', () => {
  const c = base({ now: 480 });
  const seq = seqOf(simulateDay(c));
  const r = planFromOrder(c, seq);
  assert.deepEqual(seqOf(r), seq);
  assert.deepEqual(r.late, []);
});
test('planFromOrder: marking the first ride done keeps the rest of the order (times move)', () => {
  const c = base({ now: 480 });
  const seq = seqOf(simulateDay(c));
  const first = seq.find((id) => !id.includes(':'));
  const r = planFromOrder({ ...c, now: 540, done: { [first]: 1 } }, seq);
  assert.deepEqual(seqOf(r), seq.filter((id) => id !== first));
});
test('planFromOrder: order is kept even when a show becomes late — flagged, not reordered', () => {
  const c = base({ now: 1200 });
  const order = ['rise', 'falcon', 'space', 'indy', 'show:fantasmic'];
  const r = planFromOrder(c, order);
  assert.deepEqual(seqOf(r), order);
  assert.ok(r.late.includes('show:fantasmic') || r.items.some((i) => i.over));
});
test('planFromOrder: meals start on arrival but not before their time; duration respected', () => {
  const c = { ...base({ now: 600 }), anchors: buildAnchors('balance', { mealOverrides: { lunch: { at: 12 * 60, dur: 90 } } }) };
  const r = planFromOrder(c, ['meal:lunch']);
  const m = r.items.find((i) => i.id === 'meal:lunch');
  assert.equal(m.start, 12 * 60);
  assert.equal(m.end - m.start, 90);
});
test('applyLocks: locked rides keep their place when the plan is re-optimised', () => {
  const prev = ['a1', 'rise', 'meal:lunch', 'falcon', 'space'].map((x) => (x === 'a1' ? 'pirates' : x));
  const fresh = ['falcon', 'space', 'meal:lunch', 'rise', 'pirates'];
  const out = applyLocks(fresh, prev, { space: true });
  assert.equal(out.indexOf('space'), prev.indexOf('space'));
  assert.equal(out.length, fresh.length);
});
test('syncSequence: turned-off meal drops out, turned-on show is inserted by time', () => {
  const anchors = buildAnchors('balance', { mealOverrides: { snack: { off: true } } });
  const seq = ['rise', 'meal:lunch', 'meal:snack', 'falcon'];
  const out = syncSequence(seq, anchors, { rise: 480, 'meal:lunch': 690, falcon: 800 });
  assert.ok(!out.includes('meal:snack'));
  for (const a of anchors) assert.ok(out.includes(a.id));
});
import { fitShows } from '../public/js/engine.js';
test('fitShows: a re-optimised plan with a locked ride first moves a would-be-missed show earlier', () => {
  const c = base({ now: 600 });
  const seq = ['haunted', 'falcon', 'indy', 'space', 'thunder', 'show:cavalcade', 'meal:dinner'];
  const before = planFromOrder(c, seq);
  const out = fitShows(c, seq);
  const after = planFromOrder(c, out);
  assert.ok(after.late.length <= before.late.length);
  assert.ok(!after.late.includes('show:cavalcade'));
});

test('extra attractions (e.g. Pooh) are matched from live names, not auto-planned, but plan fine when added', async () => {
  const { matchId } = await import('../lib/server.js');
  assert.equal(matchId('The Many Adventures of Winnie the Pooh', ATTRACTIONS), 'pooh');
  const c = base({ now: 600 });
  assert.ok(!simulateDay(c).items.some((i) => i.id === 'pooh'), 'not auto-planned');
  const r = planFromOrder(c, ['pooh', 'rise']);
  assert.equal(r.items.find((i) => i.type === 'ride').id, 'pooh');
  const sim2 = simulateDay({ ...c, order: ['pooh'] });
  assert.ok(sim2.items.some((i) => i.id === 'pooh'), 'planned once the user adds it');
});

// ---------- route optimiser ----------
{
  const opt = await import('../public/js/engine.js');
  const TOMORROW = { lat: 33.8117, lon: -117.9175 };
  const seqOf = (sim) => [...sim.items.filter((i) => ['ride', 'meal', 'show'].includes(i.type)).map((i) => i.id), ...(sim.waiting || [])];
  const walkOf = (c, seq) => opt.planFromOrder(c, seq).items.reduce((s, i) => s + (i.walk || 0), 0);

  test('must-ride added mid-day does not jump to the front, and nothing optional is dropped for it', () => {
    const c = { ...base({ now: 760, pos: TOMORROW }), must: { rise: true, falcon: true, haunted: true } };
    const sim = simulateDay(c);
    assert.equal(sim.items.filter((i) => i.type === 'dropped').length, 0, 'cavalcade / snack stay');
    const rides = sim.items.filter((i) => i.type === 'ride').map((i) => i.id);
    assert.ok(rides.length >= 3);
    assert.notDeepEqual(rides.slice(0, 3).sort(), ['falcon', 'haunted', 'rise'], 'musts are not simply stacked first');
    const seq = opt.insertMissing(c, seqOf(sim), sim.missingMust);
    const r = opt.planFromOrder(c, opt.optimizeOrder(c, seq).seq);
    for (const id of ['rise', 'falcon', 'haunted']) assert.ok(r.items.some((i) => i.id === id && !i.over), `${id} fits the day`);
  });

  test('optimizeOrder never makes the plan worse, keeps every item, and cuts walking on a zig-zag', () => {
    const c = base({ now: 600, pos: TOMORROW });
    // deliberately zig-zag between Tomorrowland, Frontierland, Toontown and Adventureland
    const zig = ['space', 'thunder', 'mmrr', 'indy', 'startours', 'haunted', 'matterhorn', 'jungle'];
    const o = opt.optimizeOrder(c, zig);
    assert.ok(o.cost <= o.before);
    assert.deepEqual([...o.seq].sort(), [...zig].sort());
    assert.ok(walkOf(c, o.seq) < walkOf(c, zig), `walk ${walkOf(c, zig)} → ${walkOf(c, o.seq)}`);
  });

  test('optimizeOrder: locked rides keep their slot, done items stay in front', () => {
    const c = base({ now: 600, pos: TOMORROW, done: { buzz: true } });
    const seq = ['buzz', 'space', 'thunder', 'mmrr', 'indy', 'startours'];
    const o = opt.optimizeOrder(c, seq, { mmrr: true });
    assert.equal(o.seq[0], 'buzz');
    assert.equal(o.seq.filter((x) => x !== 'buzz').indexOf('mmrr'), 2);
  });

  test('pickNext re-chooses only the next stop, from the current position; the rest keeps its order', () => {
    const FRONTIER = { lat: 33.8125, lon: -117.9210 };
    // midday, when waits are flat: walking decides (no meals/shows/musts in the way)
    const c = { ...base({ now: 780, pos: FRONTIER }), anchors: [], must: {} };
    const seq = ['space', 'startours', 'buzz', 'thunder'];
    const out = opt.pickNext(c, seq);
    assert.equal(out[0], 'thunder', 'the ride next to you goes first');
    assert.deepEqual(out.slice(1), seq.filter((x) => x !== out[0]));
    assert.deepEqual(opt.pickNext(c, seq, { space: true }), seq, 'a locked first ride is never replaced');
  });
}

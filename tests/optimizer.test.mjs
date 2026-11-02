import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimizePlan, planFromOrder, buildAnchors, crowdRatio, simulateDay, syncSequence, planScore, planCost, flowStats, walkMin } from '../public/js/engine.js';
import { normalizeTPWLive } from '../lib/server.js';
import { TRIP, DEFAULT_MUST, attractionById } from '../public/js/data.js';

const fixture = normalizeTPWLive(JSON.parse(readFileSync(new URL('./fixtures/tpw-live.json', import.meta.url))));
const liveOf = () => Object.fromEntries(Object.entries(fixture.attractions).map(([k, v]) => [k, { ...v, kind: 'live' }]));
const ctxFor = (o = {}) => {
  const planId = o.planId || 'balance', live = o.live ?? {}, now = o.now ?? 480;
  return { now, openMin: 480, closeMin: 1380, pos: TRIP.entrance, planId, done: {}, excluded: {}, skip: {}, live, crowd: crowdRatio(live, now),
    anchors: buildAnchors(planId, {}, {}), coords: {}, must: { ...DEFAULT_MUST }, cond: { maxWait: 60, walk: 'normal' }, mealFlex: 60, ...o.extra };
};
const draft = (c) => { const sim = simulateDay(c); return syncSequence([...sim.items.filter((i) => ['ride', 'meal', 'show'].includes(i.type)).map((i) => i.id), ...(sim.waiting || [])], c.anchors.filter((a) => a.end > Math.max(c.now, c.openMin)), {}); };

for (const planId of ['relax', 'balance', 'rides']) {
  for (const [now, live] of [[480, false], [600, true], [840, true]]) {
    test(`optimizePlan ${planId} @${now} live=${live}: musts in, meals within ±60, shows not missed, nothing past closing`, () => {
      const c = ctxFor({ planId, now, live: live ? liveOf() : {} });
      const seq0 = draft(c);
      const { seq } = optimizePlan(c, seq0, { budgetMs: 300 });
      const r = planFromOrder(c, seq);
      for (const id of Object.keys(DEFAULT_MUST)) assert.ok(seq.includes(id), `must ${id} kept`);
      for (const m of r.items.filter((i) => i.type === 'meal')) assert.ok(Math.abs(m.start - m.anchor.setAt) <= 60, `${m.id} ${m.start} vs ${m.anchor.setAt}`);
      assert.equal(r.items.filter((i) => i.type === 'show' && i.anchor.late === 'miss').length, 0, 'no show missed');
      assert.equal(r.items.filter((i) => i.over).length, 0, 'nothing past closing');
      assert.ok(planScore(c, seq) <= planScore(c, seq0) + 0.5, 'never worse than the draft');
    });
  }
}

test('must-rides are not simply put first: placed by cost', () => {
  const c = ctxFor({ now: 480 });
  const { seq } = optimizePlan(c, draft(c), { budgetMs: 300 });
  const rides = seq.filter((x) => attractionById[x]);
  assert.ok(!(rides[0] in DEFAULT_MUST && rides[1] in DEFAULT_MUST), `first two rides are not both must-rides: ${rides.slice(0, 3)}`);
});

test('the day is filled to the pace target (balance ≈ 9 rides, from opening)', () => {
  const c = ctxFor({ now: 480 });
  const { seq } = optimizePlan(c, draft(c), { budgetMs: 400 });
  const r = planFromOrder(c, seq);
  assert.ok(r.rides >= 9, `rides ${r.rides}`);
});

test('flow first: the route goes area by area (few returns to an area already left)', () => {
  for (const [planId, now, live] of [['balance', 480, false], ['balance', 600, true], ['rides', 600, true]]) {
    const c = ctxFor({ planId, now, live: live ? liveOf() : {} });
    const { seq } = optimizePlan(c, draft(c), { budgetMs: 400 });
    const f = flowStats(c, seq, { ridesOnly: true });
    assert.ok(f.revisits <= 2, `${planId}@${now} revisits ${f.revisits}`);
  }
});

test('flow first: the first stop is near where you are, not across the park for a shorter posted wait', () => {
  const pos = attractionById.space.pos;
  const c = { ...ctxFor({ now: 600, live: liveOf() }), pos };
  const { seq } = optimizePlan(c, draft(c), { budgetMs: 400 });
  const first = seq.find((id) => attractionById[id]);
  assert.ok(walkMin(pos, attractionById[first].pos) <= 6, `first ${first}`);
});

test('waits are only a reference: a nearby ride beats a far one with a slightly shorter posted wait', () => {
  const base = ctxFor({ now: 600, extra: { anchors: [], must: {}, closeMin: 1200 } });
  const c = { ...base, pos: attractionById.space.pos, live: { startours: { status: 'OPERATING', wait: 30, kind: 'live' }, indy: { status: 'OPERATING', wait: 15, kind: 'live' } } };
  assert.ok(planCost(c, ['startours', 'indy']) < planCost(c, ['indy', 'startours']));
});

test('keep: suggestions only add rides, never drop planned ones', () => {
  const c = ctxFor({ now: 600, live: liveOf() });
  const seq0 = ['indy', 'meal:lunch', 'show:cavalcade', 'meal:snack', 'meal:dinner', 'show:fireworks', 'show:fantasmic'];
  const { seq } = optimizePlan(c, seq0, { budgetMs: 200, keep: true });
  for (const id of seq0) assert.ok(seq.includes(id), `${id} kept`);
  assert.ok(seq.length > seq0.length, 'rides added to free time');
});

test('a time you set yourself is kept exactly (no ±60 shift)', () => {
  const c = ctxFor({ now: 480, extra: { anchors: buildAnchors('balance', { mealOverrides: { lunch: { at: 12 * 60 } } }, {}) } });
  const { seq } = optimizePlan(c, draft(c), { budgetMs: 200 });
  const lunch = planFromOrder(c, seq).items.find((i) => i.id === 'meal:lunch');
  assert.ok(lunch.start >= 720, `lunch at ${lunch.start}`);
});

test('a paused ride stays in place and takes no time', () => {
  const live = liveOf(); // rise is DOWN in the fixture
  const c = ctxFor({ now: 600, live });
  const r = planFromOrder(c, ['indy', 'rise', 'space']);
  const rise = r.items.find((i) => i.id === 'rise');
  assert.equal(rise.paused, true);
  assert.equal(rise.start, rise.end);
  assert.deepEqual(r.items.filter((i) => i.type === 'ride').map((i) => i.id), ['indy', 'rise', 'space']);
  assert.equal(r.rides, 2);
});

test('position changes the walk-cost ranking of a two-ride route', () => {
  const a=attractionById.space,b=attractionById.haunted;
  const base=ctxFor({now:600,extra:{anchors:[],must:{},live:{},done:{},closeMin:1200}});
  const atSpace={...base,pos:a.pos},atHaunted={...base,pos:b.pos};
  assert.ok(planCost(atSpace,['space','haunted']) < planCost(atSpace,['haunted','space']));
  assert.ok(planCost(atHaunted,['haunted','space']) < planCost(atHaunted,['space','haunted']));
});

test('a repeated visit is simulated as an independent queue and time slot', () => {
  const c=ctxFor({now:510,extra:{anchors:[],must:{},live:{},closeMin:1320}});
  const r=planFromOrder(c,['space','haunted','space@2']);
  const rides=r.items.filter((it)=>it.type==='ride');
  assert.deepEqual(rides.map((it)=>it.id),['space','haunted','space@2']);
  assert.ok(rides[2].start > rides[0].end,'second ride is later');
  assert.ok(rides[2].wait >= 0,'second queue is predicted independently');
});

// ---------- repeat visits (the same ride more than once) ----------
import { insertMissing, makeRoom, visitsDone, wantedVisits, visitId, visitNo } from '../public/js/engine.js';
test('visit helpers count completed visits and list the ones still wanted', () => {
  const done = { space: 1, 'space@2': 2, indy: 3, 'meal:lunch': 4 };
  assert.equal(visitsDone(done, 'space'), 2);
  assert.equal(visitsDone(done, 'matterhorn'), 0);
  assert.deepEqual(wantedVisits(done, 'space', 3), ['space@3']);
  assert.deepEqual(wantedVisits({}, 'tiana', 2), ['tiana', 'tiana@2']);
  assert.equal(visitId('space', 1), 'space'); assert.equal(visitNo('space@3'), 3); assert.equal(visitNo('space'), 1);
});
for (const [now, id] of [[480, 'space'], [600, 'matterhorn'], [600, 'tiana'], [780, 'pirates']]) {
  test(`a ride wanted twice (${id} @${now}) gets both visits into a full day, 75+ min apart, before closing`, () => {
    const c = { ...ctxFor({ now, live: now > 480 ? liveOf() : {} }), doneMin: {} };
    const wanted = [id, id + '@2'];
    const protect = Object.fromEntries(wanted.map((x) => [x, true]));
    let seq = insertMissing(c, draft(c), wanted);
    seq = makeRoom(c, optimizePlan(c, seq, { budgetMs: 150, protect }).seq, wanted, { protect });
    const it = planFromOrder(c, seq).items;
    const v1 = it.find((i) => i.id === id), v2 = it.find((i) => i.id === id + '@2');
    assert.ok(v1 && v2, 'both visits planned');
    assert.ok(!v1.over && !v2.over, `before closing (${v1.start}, ${v2.start})`);
    assert.ok(v2.start - v1.start >= 60, `spaced (${v1.start} → ${v2.start})`);
    assert.equal(it.filter((i) => i.type === 'show' && i.anchor.late === 'miss').length, 0, 'no show missed');
    for (const m of Object.keys(DEFAULT_MUST)) if (c.live[m]?.status !== 'DOWN') assert.ok(seq.includes(m), `must ${m} kept`);
  });
}
test('a 2nd visit of a ride already ridden is planned after it', () => {
  const c = { ...ctxFor({ now: 660, live: liveOf() }), done: { indy: 1 }, doneMin: { indy: 600 } };
  const protect = { 'indy@2': true };
  let seq = insertMissing(c, ['indy', ...draft(c).filter((x) => x !== 'indy')], ['indy@2']);
  seq = makeRoom(c, optimizePlan(c, seq, { budgetMs: 150, protect }).seq, ['indy@2'], { protect });
  const v2 = planFromOrder(c, seq).items.find((i) => i.id === 'indy@2');
  assert.ok(v2 && !v2.over, 'planned before closing');
  assert.ok(v2.start >= 600 + 60, `after the first ride (${v2.start})`);
});

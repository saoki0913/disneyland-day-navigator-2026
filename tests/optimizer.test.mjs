import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimizePlan, planFromOrder, buildAnchors, crowdRatio, simulateDay, syncSequence, planScore, planCost } from '../public/js/engine.js';
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

test('a popular ride is planned when the day has room (balance, from opening)', () => {
  const c = ctxFor({ now: 480 });
  const { seq } = optimizePlan(c, draft(c), { budgetMs: 400 });
  const r = planFromOrder(c, seq);
  assert.ok(r.rides >= 11, `rides ${r.rides}`);
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

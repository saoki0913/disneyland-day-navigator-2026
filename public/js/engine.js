// Pure planning / recommendation engine. No DOM, no fetch — unit-testable in Node.
import { ATTRACTIONS, attractionById, PLANS, PRIORITY, WAIT_CURVE, SHOWS, showById, restaurantById, TRIP } from './data.js';

// ---------- geometry ----------
export function distanceM(a, b) {
  if (!a || !b) return null;
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Walking-time ESTIMATE: straight line × 1.4 detour factor at 70 m/min (crowded park pace), min 2 min.
export const DETOUR = 1.4, PACE = 70;
export function walkMin(a, b) {
  const d = distanceM(a, b);
  if (d == null) return 8; // unknown position: assume a typical cross-land walk
  return Math.max(2, Math.round((d * DETOUR) / PACE));
}

// ---------- time ----------
export const hhmm = (m) => {
  m = Math.round(m);
  const h = Math.floor(m / 60), mm = ((m % 60) + 60) % 60;
  return `${h}:${String(mm).padStart(2, '0')}`;
};
export const parseHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};

// ---------- waits ----------
export function curveAt(min) {
  const h = min / 60;
  if (h <= WAIT_CURVE[0][0]) return WAIT_CURVE[0][1];
  for (let i = 1; i < WAIT_CURVE.length; i++) {
    const [h1, v1] = WAIT_CURVE[i];
    const [h0, v0] = WAIT_CURVE[i - 1];
    if (h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  }
  return WAIT_CURVE[WAIT_CURVE.length - 1][1];
}
export function estimateWait(a, min) {
  return Math.max(5, Math.round((a.peak * curveAt(min)) / 5) * 5);
}

/**
 * Resolve the wait used for planning a ride at time `atMin`.
 * live: { [id]: { status, wait, kind:'live' } }  (kind live = API value)
 * crowd: today's live/estimate ratio, used to scale future estimates.
 */
export function waitFor(a, atMin, ctx) {
  const lv = ctx.live?.[a.id];
  const nearNow = Math.abs(atMin - ctx.now) <= 30;
  if (lv && nearNow && lv.status === 'OPERATING' && Number.isFinite(lv.wait)) {
    return { wait: lv.wait, kind: lv.kind || 'live' };
  }
  const est = Math.round((estimateWait(a, atMin) * (ctx.crowd || 1)) / 5) * 5;
  return { wait: Math.max(5, est), kind: 'est' };
}

export function crowdRatio(live, now) {
  const ratios = [];
  for (const a of ATTRACTIONS) {
    const lv = live?.[a.id];
    if (lv && lv.status === 'OPERATING' && Number.isFinite(lv.wait) && a.peak >= 30) {
      ratios.push(Math.max(5, lv.wait) / estimateWait(a, now));
    }
  }
  if (ratios.length < 4) return 1;
  ratios.sort((x, y) => x - y);
  const med = ratios[Math.floor(ratios.length / 2)];
  return Math.min(1.6, Math.max(0.6, med));
}

// Availability: returns {ok, reason}
export function availability(a, ctx) {
  const lv = ctx.live?.[a.id];
  if (!lv) return { ok: true };
  if (ctx.preopen || ctx.now < ctx.openMin) return { ok: true }; // before opening every ride is "CLOSED"
  if (lv.status === 'OPERATING') return { ok: true };
  if (lv.status === 'DOWN') return { ok: false, reason: '一時休止中', temporary: true };
  if (lv.status === 'REFURBISHMENT') return { ok: false, reason: 'リニューアル休止中' };
  if (lv.status === 'CLOSED') return { ok: false, reason: '営業時間外／休止', temporary: true };
  return { ok: true };
}

// ---------- anchors (meals + shows) ----------
/**
 * Build the fixed blocks for the selected plan.
 * prefs: { mealOverrides:{id:{at,restaurant,off}}, shows:{id:{on,pick}}, showTimes:{id:[...]} }
 */
export function buildAnchors(planId, prefs = {}, done = {}) {
  const plan = PLANS[planId] || PLANS.balance;
  const out = [];
  for (const m of plan.meals) {
    const ov = prefs.mealOverrides?.[m.id] || {};
    if (ov.off) continue;
    const r = restaurantById[ov.restaurant || m.restaurant];
    out.push({
      id: 'meal:' + m.id, kind: 'meal', title: m.ja, place: r?.ja, restaurant: r?.id,
      start: ov.at ?? m.at, end: (ov.at ?? m.at) + (ov.dur ?? m.dur), claim: 0,
      pos: r?.pos, emoji: r?.emoji || '🍽️', done: !!done['meal:' + m.id], flex: m.id === 'snack',
    });
  }
  for (const s of SHOWS) {
    const sp = prefs.shows?.[s.id];
    const on = sp?.on ?? plan.shows[s.id];
    if (!on) continue;
    const times = prefs.showTimes?.[s.id] || s.times;
    let pick = sp?.pick && times.includes(sp.pick) ? sp.pick : (times.includes(s.defaultPick) ? s.defaultPick : times[0]);
    if (!pick) continue;
    const start = parseHHMM(pick);
    out.push({
      id: 'show:' + s.id, kind: 'show', title: s.short, place: s.venue, show: s.id, times: times.map(parseHHMM),
      start, end: start + s.dur, claim: s.claim, pos: s.venuePos, emoji: s.emoji,
      done: !!done['show:' + s.id], flex: !!s.flex,
    });
  }
  out.sort((a, b) => a.start - b.start);
  // Merge chained night shows: if a show's claim window starts before the previous
  // anchor ends (e.g. fireworks 21:30 then Fantasmic 22:30 at the same river), we
  // keep both but the second starts claiming as soon as the first ends.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i];
    if (cur.start - cur.claim < prev.end) cur.claim = Math.max(0, cur.start - prev.end);
  }
  return out;
}

// conflict check: overlapping anchors (incl. claim windows)
export function anchorConflicts(anchors) {
  const res = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (b.start - b.claim < a.end) res.push([a.id, b.id]);
  }
  return res;
}

// ---------- plan conditions ----------
// ctx.must: { rideId: true } — rides the user marked "絶対乗る" (default: both Star Wars rides).
// ctx.cond: { maxWait, walk:'low'|'normal'|'any' } — user conditions layered on top of the pace preset.
export const DEFAULT_MUST = { rise: true, falcon: true };
export const mustOf = (ctx) => ctx.must || DEFAULT_MUST;
export const isMust = (a, ctx) => !!mustOf(ctx)[a.id];
const WALK_W = { low: 1.8, normal: 1, any: 0.5 };
export function effectivePlan(ctx) {
  const base = PLANS[ctx.planId] || PLANS.balance;
  const c = ctx.cond || {};
  return {
    ...base,
    maxWait: c.maxWait ?? base.maxWait,
    walkWeight: base.walkWeight * (WALK_W[c.walk] ?? 1),
    waitWeight: base.waitWeight * (c.maxWait != null && c.maxWait <= 30 ? 1.5 : 1),
  };
}

// ---------- scoring ----------
function scoreRide(a, c, plan, ctx) {
  const pref = PRIORITY[a.id] ?? 0;
  let s = a.pop * 8 + pref;
  const reasons = [];
  const must = isMust(a, ctx);
  if (must) {
    s += 40;
    // urgency grows as the day runs out
    const left = ctx.closeMin - ctx.now;
    if (left < 6 * 60) s += 25;
    if (left < 3 * 60) s += 40;
    reasons.push({ k: 'must', t: '絶対乗る' });
  }
  const typical = estimateWait(a, ctx.now);
  s -= c.wait * plan.waitWeight;
  s -= c.walk * plan.walkWeight;
  if (!must && c.wait > plan.maxWait) s -= (c.wait - plan.maxWait) * 1.5;
  if (c.kind !== 'est' && c.wait <= typical * 0.75 && typical - c.wait >= 10) {
    s += Math.min(25, (typical - c.wait) * 0.6);
    reasons.push({ k: 'dip', t: `いつもより空いている（通常${typical}分前後）` });
  }
  // Rides whose waits climb later get a morning boost.
  const later = estimateWait(a, Math.min(ctx.now + 180, 15 * 60));
  if (later - typical >= 15 && a.pop >= 4) {
    s += (later - typical) * 0.25;
    reasons.push({ k: 'later', t: `この後は混みやすい（午後は${later}分前後の見込み）` });
  }
  if (c.wait <= 20) reasons.push({ k: 'short', t: `待ち時間が短い（${c.wait}分）` });
  if (c.walk <= 4) reasons.push({ k: 'near', t: `すぐ近く（徒歩${c.walk}分目安）` });
  if (!must && a.pop >= 5) reasons.push({ k: 'pop', t: '人気No.1クラス' });
  return { score: s, reasons };
}

/**
 * Main recommendation.
 * ctx: { now, openMin, closeMin, pos, planId, done:{id:true}, skip:{id:untilMin}, live, crowd,
 *        anchors, coords:{id:pos}, excluded:{id:true} }
 */
export function recommend(ctx) {
  const plan = effectivePlan(ctx);
  const now = Math.max(ctx.now, ctx.openMin);
  const c2 = { ...ctx, now, preopen: ctx.now < ctx.openMin };
  const pos = ctx.pos;
  const posOf = (a) => ctx.coords?.[a.id] || a.pos;

  const upcoming = (ctx.anchors || []).filter((x) => !x.done && x.end > now && !(x.kind === 'show' && now > x.start + 5));
  const next = upcoming[0] || null;
  const result = { now, next, primary: null, alts: [], blocked: [], mode: 'ride', notes: [] };

  if (ctx.now >= ctx.closeMin) { result.mode = 'closed'; return result; }

  // Anchor timing
  let deadline = ctx.closeMin - 5; // must be finished (incl. walking) by this
  let anchorDue = false;
  if (next) {
    const walkToNext = walkMin(pos, next.pos);
    const leaveBy = next.start - next.claim - walkToNext;
    if (now >= leaveBy - 5) anchorDue = true;
    deadline = next.start - next.claim;
    result.leaveBy = leaveBy;
    result.walkToNext = walkToNext;
  }

  // Score rides
  const doneCount = Object.keys(ctx.done || {}).filter((k) => attractionById[k]).length;
  const cands = [];
  for (const a of ATTRACTIONS) {
    if (ctx.done?.[a.id] || ctx.excluded?.[a.id]) continue;
    const av = availability(a, c2);
    if (!av.ok) { result.blocked.push({ a, reason: av.reason, temporary: av.temporary }); continue; }
    const p = posOf(a);
    const walk = walkMin(pos, p);
    const w = waitFor(a, now + walk, c2);
    const finish = now + walk + w.wait + a.dur;
    const backToAnchor = next ? walkMin(p, next.pos) : 0;
    const c = { a, walk, wait: w.wait, kind: w.kind, finish, total: walk + w.wait + a.dur };
    // After the last fixed event you only need to JOIN the queue before closing.
    const fitsClose = !next && now + walk <= ctx.closeMin - 2;
    let bumps = null;
    if (finish + backToAnchor > deadline && !fitsClose) {
      // A must-ride may push optional blocks (snack break, cavalcade) back / out of the way,
      // as long as the next FIXED block (meal or night show) still fits.
      let k = 0;
      while (upcoming[k]?.flex) k++;
      const fixedNext = upcoming[k];
      const ok = fixedNext
        ? finish + walkMin(p, fixedNext.pos) <= fixedNext.start - fixedNext.claim
        : now + walk <= ctx.closeMin - 2;
      // Soft deadline for must-rides: shorter spot-claiming for shows, or a meal up to 30 min later.
      const softDl = next ? (next.kind === 'show' ? next.start - 5 : next.start + 30) : -1;
      if (isMust(a, ctx) && k > 0 && ok) {
        bumps = upcoming.slice(0, k).map((x) => x.id);
      } else if (isMust(a, ctx) && next && !next.flex && finish + backToAnchor <= softDl) {
        c.soft = next.kind === 'show' ? 'claim' : 'meal';
      } else {
        if (isMust(a, ctx)) result.blocked.push({ a, reason: next ? `${next.title}（${hhmm(next.start)}）までに間に合わない` : '閉園までに間に合わない', temporary: true, fit: true });
        continue;
      }
    }
    if (fitsClose && finish > deadline) c.lastCall = true;
    c.bumps = bumps;
    if (ctx.skip?.[a.id] && ctx.skip[a.id] > ctx.now) continue;
    const { score, reasons } = scoreRide(a, c, plan, c2);
    if (c.soft) reasons.push({ k: 'soft', t: c.soft === 'claim' ? `必須を優先：${next.title}の場所取りは短め（開演直前に到着）` : `必須を優先：${next.title}を少し遅らせる（〜${hhmm(finish + backToAnchor)}）` });
    else if (bumps) reasons.push({ k: 'bump', t: `必須のため${next.title}（${hhmm(next.start)}）を後ろにずらす/見送る` });
    else if (c.lastCall) reasons.push({ k: 'close', t: `閉園${hhmm(ctx.closeMin)}までに列に並べば乗れる` });
    else if (next) reasons.push({ k: 'fit', t: `${next.title}（${hhmm(next.start)}）に間に合う` });
    c.score = score; c.reasons = reasons;
    cands.push(c);
  }

  // After plan's ride target is reached, only light suggestions (short waits) remain.
  const targetReached = doneCount >= plan.targetRides;

  // An optional block (snack / cavalcade) yields to a pending must-ride that can only fit by bumping it.
  if (anchorDue && next?.flex && cands.some((c) => isMust(c.a, ctx) && c.bumps)) anchorDue = false;
  if (anchorDue && next) {
    result.mode = 'anchor';
    result.primary = { type: 'anchor', anchor: next, walk: result.walkToNext };
  }

  cands.sort((x, y) => y.score - x.score);
  let pool = cands;
  if (targetReached) pool = cands.filter((c) => isMust(c.a, ctx) || c.wait <= 25);

  // A destination the user explicitly chose (e.g. from a "再開しました" alert) goes first.
  const pinned = ctx.pin && ctx.pin.until > ctx.now ? cands.find((c) => c.a.id === ctx.pin.id) : null;
  if (pinned && !result.primary) {
    pinned.reasons = [{ k: 'pin', t: 'あなたが選んだ行き先' }, ...pinned.reasons];
    result.primary = { type: 'ride', ...pinned };
  }
  if (!result.primary) {
    if (pool.length) {
      result.primary = { type: 'ride', ...pool[0] };
    } else {
      result.mode = 'free';
      result.primary = { type: 'free', minutes: Math.max(0, Math.round(deadline - now)), next };
    }
  }

  // Alternatives labelled by criterion
  const used = new Set([result.primary?.a?.id]);
  const pick = (label, key, arr) => {
    const c = arr.find((x) => !used.has(x.a.id));
    if (c) { used.add(c.a.id); result.alts.push({ label, key, ...c }); }
  };
  const byWait = [...pool].sort((x, y) => x.wait - y.wait || y.score - x.score);
  const byWalk = [...pool].sort((x, y) => x.walk - y.walk || y.score - x.score);
  const byPop = [...pool].sort((x, y) => (y.a.pop * 10 + (PRIORITY[y.a.id] || 0)) - (x.a.pop * 10 + (PRIORITY[x.a.id] || 0)));
  if (result.mode === 'anchor') pick('時間があれば', 'score', pool);
  pick('待ち時間優先', 'wait', byWait);
  pick('距離優先', 'walk', byWalk);
  pick('人気度優先', 'pop', byPop);

  // must-ride status notes
  for (const id of Object.keys(mustOf(ctx))) {
    if (ctx.done?.[id]) continue;
    const b = result.blocked.find((x) => x.a.id === id);
    if (b) result.notes.push({ id, text: `${attractionById[id].short}：${b.reason}`, temporary: b.temporary, fit: !!b.fit });
  }
  return result;
}

/**
 * Forward-simulate the rest of the day for the Plan tab.
 * Greedy: repeatedly take the engine's primary recommendation.
 */
export function simulateDay(ctx) {
  const items = [];
  const done = { ...(ctx.done || {}) };
  const anchors = (ctx.anchors || []).map((a) => ({ ...a }));
  let now = Math.max(ctx.now, ctx.openMin);
  let pos = ctx.pos;
  let guard = 0;
  const startNow = ctx.now;
  while (now < ctx.closeMin - 2 && guard++ < 80) {
    // Only trust live waits/status near the real current time.
    const liveNear = now - startNow <= 30 ? ctx.live : stripDown(ctx.live, ctx);
    const r = recommend({ ...ctx, now, pos, done, anchors, live: liveNear, skip: {} });
    const p = r.primary;
    if (!p) break;
    if (p.type === 'ride') {
      const start = now + p.walk;
      items.push({ type: 'ride', id: p.a.id, a: p.a, walk: p.walk, start, wait: p.wait, waitKind: p.kind, end: p.finish, must: isMust(p.a, ctx), reasons: p.reasons });
      done[p.a.id] = true;
      if (p.bumps) {
        const here = (ctx.coords?.[p.a.id]) || p.a.pos;
        const fixed = anchors.filter((x) => !x.done && !x.flex && x.start > p.finish).sort((x, y) => x.start - y.start)[0];
        let t = p.finish;
        for (const id of p.bumps) {
          const b = anchors.find((x) => x.id === id);
          const d = b.end - b.start;
          const earliest = t + walkMin(here, b.pos) + (b.claim || 0);
          if (b.kind === 'show') {
            // Shows can't move: switch to a later performance if there is one.
            const later = (b.times || []).find((x) => x >= earliest);
            if (later == null) { b.done = true; b.dropped = true; items.push({ type: 'dropped', id: b.id, anchor: b, start: p.finish, end: p.finish }); continue; }
            b.start = later;
          } else b.start = earliest;
          b.end = b.start + d;
          if (fixed && b.end + walkMin(b.pos, fixed.pos) > fixed.start - fixed.claim) {
            b.done = true; b.dropped = true;
            items.push({ type: 'dropped', id: b.id, anchor: b, start: p.finish, end: p.finish });
          } else { b.shifted = true; t = b.end; }
        }
        anchors.sort((x, y) => x.start - y.start);
      }
      now = p.finish;
      pos = (ctx.coords?.[p.a.id]) || p.a.pos;
    } else if (p.type === 'anchor') {
      const a = p.anchor;
      if (a.kind === 'meal' && now + p.walk > a.start) { const d = a.end - a.start; a.start = now + p.walk; a.end = a.start + d; a.shifted = true; }
      const arrive = Math.max(now + p.walk, a.start - a.claim);
      items.push({ type: a.kind, id: a.id, anchor: a, start: a.start, claimFrom: a.claim ? arrive : null, end: a.end, walk: p.walk });
      a.done = true;
      now = Math.max(a.end, now + p.walk);
      pos = a.pos || pos;
    } else {
      // free time until it's time to head to the next anchor (or close)
      if (p.next) {
        const leave = p.next.start - p.next.claim - walkMin(pos, p.next.pos) - 5;
        if (leave > now) items.push({ type: 'free', start: now, end: leave, minutes: leave - now });
        now = Math.max(now + 5, leave);
      } else {
        items.push({ type: 'free', start: now, end: ctx.closeMin, minutes: ctx.closeMin - now });
        break;
      }
    }
  }
  // any remaining anchors that are still in the future (should be none) — add for visibility
  for (const a of anchors) if (!a.done && a.end > Math.max(ctx.now, ctx.openMin) && !items.some((i) => i.id === a.id)) {
    items.push({ type: a.kind, id: a.id, anchor: a, start: a.start, end: a.end });
  }
  items.sort((x, y) => x.start - y.start);
  const missingMust = Object.keys(mustOf(ctx)).filter((id) => !done[id] && !ctx.excluded?.[id]);
  return { items, missingMust, rides: items.filter((i) => i.type === 'ride').length };
}

// For future times, a ride that is DOWN now is assumed to reopen (temporary).
// Long-term closures (REFURBISHMENT, or CLOSED during operating hours) stay closed.
function stripDown(live, ctx) {
  if (!live) return live;
  const out = {};
  for (const [k, v] of Object.entries(live)) {
    if (v.status === 'DOWN') continue;
    if (v.status === 'CLOSED' && ctx.now < ctx.openMin) continue;
    out[k] = { ...v, wait: null };
  }
  return out;
}

// ---------- user-edited plan (fixed order) ----------
/**
 * Lay out a user-ordered plan. order: ['rideId' | 'meal:lunch' | 'show:fantasmic', ...]
 * - rides: walk + wait (live near now, estimate later) + ride, in the given order
 * - meals: start whenever you arrive (time follows the order), duration from the anchor
 * - shows: fixed performance time; arriving early leaves free time, arriving late is flagged
 * Returns the same shape as simulateDay: { items, missingMust, rides, late }.
 */
export function planFromOrder(ctx, order) {
  const anchorById = Object.fromEntries((ctx.anchors || []).map((a) => [a.id, a]));
  const startNow = ctx.now;
  let now = Math.max(ctx.now, ctx.openMin);
  let pos = ctx.pos;
  const items = [];
  const scheduled = {};
  let late = 0;
  for (const id of order || []) {
    if (ctx.done?.[id]) continue;
    const a = attractionById[id];
    if (a) {
      const p = ctx.coords?.[a.id] || a.pos;
      const walk = walkMin(pos, p);
      const live = now - startNow <= 30 ? ctx.live : stripDown(ctx.live, ctx);
      const av = availability(a, { ...ctx, live, now: Math.max(startNow, ctx.openMin), preopen: startNow < ctx.openMin });
      if (!av.ok) { items.push({ type: 'ride', id, a, blocked: av.reason, start: now, end: now, walk, wait: null, must: isMust(a, ctx) }); continue; }
      const start = now + walk;
      if (start > ctx.closeMin - 2) { items.push({ type: 'ride', id, a, over: true, start, end: start, walk, wait: null, must: isMust(a, ctx) }); continue; }
      const w = waitFor(a, start, { ...ctx, live });
      const end = start + w.wait + a.dur;
      items.push({ type: 'ride', id, a, walk, start, wait: w.wait, waitKind: w.kind, end, must: isMust(a, ctx) });
      scheduled[id] = true;
      now = end; pos = p;
      continue;
    }
    const x = anchorById[id];
    if (!x || x.done) continue;
    const walk = walkMin(pos, x.pos);
    const arrive = now + walk;
    if (x.kind === 'meal') {
      const d = x.end - x.start;
      const an = { ...x, start: arrive, end: arrive + d, shifted: arrive !== x.start };
      items.push({ type: 'meal', id, anchor: an, start: arrive, end: an.end, walk });
      now = an.end; pos = x.pos || pos;
    } else {
      const claimFrom = x.start - (x.claim || 0);
      const an = { ...x };
      if (arrive > x.start + 5) { an.late = 'miss'; late++; }
      else if (arrive > claimFrom) an.late = 'short';
      if (!an.late && claimFrom - walk - now >= 10) items.push({ type: 'free', start: now, end: claimFrom - walk, minutes: claimFrom - walk - now });
      items.push({ type: 'show', id, anchor: an, start: x.start, claimFrom: Math.max(arrive, claimFrom), end: x.end, walk });
      if (an.late !== 'miss') { now = Math.max(x.end, arrive); pos = x.pos || pos; }
    }
  }
  if (now < ctx.closeMin - 10) items.push({ type: 'free', start: now, end: ctx.closeMin, minutes: ctx.closeMin - now });
  const missingMust = Object.keys(mustOf(ctx)).filter((id) => !ctx.done?.[id] && !scheduled[id] && !ctx.excluded?.[id]);
  return { items, missingMust, rides: items.filter((i) => i.type === 'ride' && !i.blocked && !i.over).length, late };
}

/** Choose where to insert `id` into `order` so the day flows best (no missed shows, least total time). */
export function bestInsert(ctx, order, id) {
  const cost = (o) => {
    const r = planFromOrder(ctx, o);
    const over = r.items.filter((i) => i.over).length;
    const last = r.items.filter((i) => i.type !== 'free').pop();
    return r.late * 10000 + over * 5000 + (last ? last.end : 0);
  };
  let best = null;
  for (let i = 0; i <= order.length; i++) {
    const o = [...order.slice(0, i), id, ...order.slice(i)];
    const c = cost(o);
    if (!best || c < best.c) best = { c, o, i };
  }
  return best.o;
}

export const _test = { scoreRide, stripDown };

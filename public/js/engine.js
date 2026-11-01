// Pure planning / recommendation engine. No DOM, no fetch — unit-testable in Node.
import { ATTRACTIONS, attractionById, PLANS, PRIORITY, WAIT_CURVE, SHOWS, showById, restaurantById, DEFAULT_MUST } from './data.js';
export { DEFAULT_MUST };
// A second visit is an independent itinerary stop (e.g. 'space@2'), not a duplicate DOM key.
export const baseRideId = (id) => String(id || '').replace(/@\d+$/, '');
export const rideAt = (id) => attractionById[baseRideId(id)];

// ---------- geometry ----------
export function distanceM(a, b) {
  if (!a || !b) return null;
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Ignore GPS noise and avoid repainting more often than once every 12 seconds.
export function gpsNeedsRedraw(last, next, elapsedMs) {
  if (!last) return true;
  if (elapsedMs < 12000) return false;
  const jitter = Math.max(25, Math.min(80, Math.max(last.acc || 0, next.acc || 0) * 0.75));
  return distanceM(last, next) >= jitter || (Number.isFinite(last.acc) && Number.isFinite(next.acc) && last.acc - next.acc >= 25);
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

// A manually chosen planning clock keeps advancing after the user selects a start time.
export function movingPlanMin(override, nowMs) {
  if (!override || !Number.isFinite(override.base) || !Number.isFinite(override.setAt)) return null;
  return override.base + Math.max(0, nowMs - override.setAt) / 60000;
}
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
  // Future times: start from this ride's own live/typical ratio and fade towards the
  // park-wide crowd ratio over ~3 hours (a ride that is busy now tends to stay busy for a while).
  const crowd = ctx.crowd || 1;
  const own = ctx.rideRatio?.[a.id];
  let ratio = crowd;
  if (Number.isFinite(own)) {
    const k = Math.max(0, 1 - Math.max(0, atMin - (ctx.liveAt ?? ctx.now)) / 180);
    ratio = own * k + crowd * (1 - k);
  }
  const est = Math.round((estimateWait(a, atMin) * ratio) / 5) * 5;
  return { wait: Math.max(5, est), kind: 'est' };
}

// Per-ride ratio of the current LIVE wait to the typical wait at this time (clamped).
export function rideRatios(live, now) {
  const out = {};
  for (const a of ATTRACTIONS) {
    const lv = live?.[a.id];
    if (lv && lv.status === 'OPERATING' && Number.isFinite(lv.wait)) {
      out[a.id] = Math.min(2.5, Math.max(0.4, Math.max(5, lv.wait) / estimateWait(a, now)));
    }
  }
  return out;
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
      start: ov.at ?? m.at, end: (ov.at ?? m.at) + (ov.dur ?? m.dur), claim: 0, fixed: ov.at != null, // a time you set yourself is kept exactly
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
    // Must-rides only need to FIT the day; the route optimiser decides where. A small bonus keeps them
    // in the draft, and urgency only grows when the day is running out.
    s += 12;
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
    // minor extras are only planned on request (added to the plan, must, or chosen as the next stop)
    if (a.extra && !mustOf(ctx)[a.id] && !(ctx.order || []).includes(a.id) && ctx.pin?.id !== a.id) continue;
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
      // Only when the day is running out: earlier, a must-ride simply waits for a slot that fits
      // (the route optimiser places it), instead of jumping to the front and pushing plans away.
      const urgent = ctx.closeMin - now < 5 * 60;
      if (isMust(a, ctx) && urgent && k > 0 && ok) {
        bumps = upcoming.slice(0, k).map((x) => x.id);
      } else if (isMust(a, ctx) && urgent && next && !next.flex && finish + backToAnchor <= softDl) {
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
  // The user's own ride order (drag & drop on the plan): the first ordered ride that still
  // fits before the next fixed block. Rides that don't fit yet come after that block.
  if (!result.primary && ctx.order?.length) {
    for (const id of ctx.order) {
      const c = cands.find((x) => x.a.id === id);
      if (!c) continue;
      const why = ctx.orderReason || { k: 'order', t: 'あなたが決めた順番' };
      c.reasons = [why, ...c.reasons.filter((x) => x.k !== why.k)];
      result.primary = { type: 'ride', ...c };
      break;
    }
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
    const r = recommend({ ...ctx, now, pos, done, anchors, live: liveNear, skip: {}, liveAt: ctx.liveAt ?? startNow });
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
  // Rides that are temporarily DOWN right now: kept out of the timeline, listed separately.
  const waiting = ctx.now >= ctx.openMin
    ? ATTRACTIONS.filter((a) => ctx.live?.[a.id]?.status === 'DOWN' && !done[a.id] && !ctx.excluded?.[a.id]).map((a) => a.id)
    : [];
  const missingMust = Object.keys(mustOf(ctx)).filter((id) => !done[id] && !ctx.excluded?.[id] && !waiting.includes(id));
  return { items, missingMust, waiting, rides: items.filter((i) => i.type === 'ride').length };
}

// ---------- the user's plan: fixed sequence, times recomputed ----------
/**
 * Lay out a plan in EXACTLY the given order (rides, 'meal:x', 'show:x'); nothing is reordered.
 * - ride: walk + wait (live near now, estimate later) + ride
 * - meal: starts on arrival, but not before its chosen time (time follows the order when moved)
 * - show: fixed performance time; arriving early leaves free time, arriving late is only flagged
 * - rides that are down now go to `waiting` (they keep their place in the order for later)
 * Returns { items, waiting, missingMust, rides, late }.
 */
export function planFromOrder(ctx, order) {
  const anchorById = Object.fromEntries((ctx.anchors || []).map((a) => [a.id, a]));
  const startNow = ctx.now;
  let now = Math.max(ctx.now, ctx.openMin);
  let pos = ctx.pos;
  const items = [], waiting = [], scheduled = {};
  const late = [];
  for (const id of order || []) {
    if (ctx.done?.[id]) continue;
    const a = rideAt(id);
    if (a) {
      const p = ctx.coords?.[a.id] || a.pos;
      const live = now - startNow <= 30 ? ctx.live : stripDown(ctx.live, ctx);
      const av = availability(a, { ...ctx, live, now: Math.max(startNow, ctx.openMin), preopen: startNow < ctx.openMin });
      // paused now: stays in its place in the plan, marked, and takes no time (the plan does not move)
      if (!av.ok) { waiting.push(id); items.push({ type: 'ride', id, a, paused: true, walk: 0, start: now, end: now, wait: null, waitKind: 'live', must: isMust(a, ctx) }); continue; }
      const walk = walkMin(pos, p);
      const start = now + walk;
      const w = waitFor(a, start, { ...ctx, live });
      const end = start + w.wait + a.dur;
      const it = { type: 'ride', id, a, walk, start, wait: w.wait, waitKind: w.kind, end, must: isMust(a, ctx) };
      if (start > ctx.closeMin - 2) { it.over = true; late.push(id); }
      items.push(it);
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
      // ctx.mealFlex: a meal may start up to this many minutes BEFORE its set time when you arrive early
      // (0 = never before). A pinned meal (x.fixed) always keeps its time.
      const flex = x.fixed ? 0 : (ctx.mealFlex || 0);
      const start = Math.max(arrive, x.start - flex);
      if (start - walk - now >= 10) items.push({ type: 'free', start: now, end: start - walk, minutes: start - walk - now });
      const an = { ...x, start, end: start + d, shifted: Math.abs(start - x.start) > 4, setAt: x.start };
      items.push({ type: 'meal', id, anchor: an, start, end: an.end, walk });
      now = an.end; pos = x.pos || pos;
    } else {
      const claimFrom = x.start - (x.claim || 0);
      const an = { ...x };
      if (arrive > x.start + 5) { an.late = 'miss'; late.push(id); }
      else if (arrive > claimFrom + 5) an.late = 'short';
      if (!an.late && claimFrom - walk - now >= 10) items.push({ type: 'free', start: now, end: claimFrom - walk, minutes: claimFrom - walk - now });
      items.push({ type: 'show', id, anchor: an, start: x.start, claimFrom: Math.max(arrive, claimFrom), end: x.end, walk });
      if (an.late !== 'miss') { now = Math.max(x.end, arrive); pos = x.pos || pos; }
    }
  }
  if (now < ctx.closeMin - 10) items.push({ type: 'free', start: now, end: ctx.closeMin, minutes: ctx.closeMin - now });
  const missingMust = Object.keys(mustOf(ctx)).filter((id) => !ctx.done?.[id] && !scheduled[id] && !ctx.excluded?.[id] && !waiting.includes(id));
  return { items, waiting, missingMust, late, rides: items.filter((i) => i.type === 'ride' && !i.over && !i.paused).length };
}

/**
 * Keep the plan's sequence in sync with the current meals/shows: drop ones that were turned off,
 * insert newly turned-on ones by their time (before the first item that starts later).
 * prevStarts: { id: plannedStart } from the previous layout.
 */
export function syncSequence(seq, anchors, prevStarts = {}) {
  const ids = new Set(anchors.map((a) => a.id));
  const out = seq.filter((id) => rideAt(id) || ids.has(id));
  for (const a of anchors) {
    if (out.includes(a.id)) continue;
    const i = out.findIndex((id) => (prevStarts[id] ?? Infinity) > a.start);
    out.splice(i < 0 ? out.length : i, 0, a.id);
  }
  return out;
}

/**
 * For a re-optimised plan only (not for the user's own moves): a show that would be missed is moved
 * earlier, right after the last item that still ends before its spot-claiming time.
 */
export function fitShows(ctx, seq) {
  let out = [...seq];
  for (let guard = 0; guard < 6; guard++) {
    const r = planFromOrder(ctx, out);
    const lateShow = r.items.find((i) => i.type === 'show' && i.anchor.late === 'miss');
    if (!lateShow) break;
    const claimFrom = lateShow.anchor.start - (lateShow.anchor.claim || 0);
    const before = r.items.filter((i) => i.id && i.id !== lateShow.id && i.end + 10 <= claimFrom).map((i) => i.id);
    const lastId = before.at(-1);
    out = out.filter((x) => x !== lateShow.id);
    const k = lastId ? out.indexOf(lastId) + 1 : out.findIndex((x) => !ctx.done?.[x]);
    out.splice(k < 0 ? 0 : k, 0, lateShow.id);
  }
  return out;
}

/** Locked rides keep their index in the open (not-done) part of the previous sequence. */
export function applyLocks(fresh, prevSeq, locks = {}, done = {}) {
  const locked = Object.keys(locks).filter((id) => locks[id] && rideAt(id) && !done[id] && prevSeq.includes(id));
  if (!locked.length) return fresh;
  const prevOpen = prevSeq.filter((id) => !done[id]);
  const out = fresh.filter((id) => !locked.includes(id));
  for (const id of locked.sort((a, b) => prevOpen.indexOf(a) - prevOpen.indexOf(b))) {
    out.splice(Math.min(prevOpen.indexOf(id), out.length), 0, id);
  }
  return out;
}

// For future times we don't know WHEN a DOWN ride reopens, so it stays out of the plan
// ("再開待ち") until live data says it is operating again — then it comes back automatically.
// Long-term closures (REFURBISHMENT, or CLOSED during operating hours) stay closed too.
function stripDown(live, ctx) {
  if (!live) return live;
  const out = {};
  for (const [k, v] of Object.entries(live)) {
    if (v.status === 'DOWN' && ctx.now >= ctx.openMin) { out[k] = { ...v, wait: null }; continue; }
    if (v.status === 'DOWN') continue;
    if (v.status === 'CLOSED' && ctx.now < ctx.openMin) continue;
    out[k] = { ...v, wait: null };
  }
  return out;
}

// ---------- route optimisation ----------
// Cost of a sequence in "minutes you'd rather not spend": walking (weighted by the walk condition),
// queueing, meals pushed late, shows reached late, rides that no longer fit before closing.
// Lower is better. Free time costs nothing — it is what a good route buys you.
/** Real minutes spent walking + queueing in a sequence (what the user would actually save). */
export function planMinutes(ctx, seq) {
  return planFromOrder(ctx, seq).items.reduce((t, it) => t + (it.walk || 0) + (it.type === 'ride' && !it.over && !it.paused ? it.wait : 0), 0);
}
export function planCost(ctx, seq) {
  const r = planFromOrder(ctx, seq);
  const plan = effectivePlan(ctx);
  const walkCost = 1.8 * (WALK_W[ctx.cond?.walk] ?? 1);
  const orig = Object.fromEntries((ctx.anchors || []).map((a) => [a.id, a]));
  let cost = 0;
  // The first leg starts at the current GPS point; don't discount it.
  const first = r.items.find((i) => ['ride','meal','show'].includes(i.type) && !i.paused);
  if (ctx.pos && first) cost += (first.walk || 0) * 1.75;
  let lastLand = null, priorLand = null;
  for (const it of r.items) {
    if (it.type === 'ride') {
      if (it.paused) continue;
      const land = it.a?.land || null;
      if (land && priorLand === land && land !== lastLand) cost += 5; // avoid zig-zagging back
      if (land && lastLand && land !== lastLand) priorLand = lastLand;
      if (land) lastLand = land;
      cost += it.walk * walkCost + it.wait;
      if (!it.must && it.wait > plan.maxWait) cost += (it.wait - plan.maxWait);
      if (it.over) cost += it.must ? 5000 : 400;
      else if (it.must) {
        // keep a safety margin: a must-ride planned into the last 90 minutes may slip out if waits rise
        const tail = it.end - (ctx.closeMin - 90);
        if (tail > 0) cost += tail * 2;
      }
    } else if (it.type === 'meal') {
      // moving a meal costs a little per minute; beyond the allowed window (mealFlex) it costs a lot
      const dev = it.start - (orig[it.id]?.start ?? it.start), flex = ctx.mealFlex || 0;
      const lateOver = Math.max(0, dev - flex);
      cost += it.walk * walkCost + (flex ? Math.abs(dev) * 0.4 + lateOver * 3 : Math.max(0, dev) * 1.5);
    } else if (it.type === 'show') {
      cost += it.walk * walkCost + (it.anchor.late === 'miss' ? 3000 : it.anchor.late === 'short' ? 120 : 0);
    }
  }
  // Repeat rides should be separated in time, not ridden back-to-back by the planner.
  const starts = new Map();
  for (const it of r.items.filter((x) => x.type === 'ride' && !x.paused && !x.over)) {
    const base = baseRideId(it.id);
    const prev = starts.get(base) ?? (ctx.done?.[base] && Number.isFinite(ctx.doneMin?.[base]) ? ctx.doneMin[base] : null);
    if (prev != null && it.id !== base) cost += Math.max(0, 75 - (it.start - prev)) * 18;
    if (it.id !== base && !starts.has(base) && !ctx.done?.[base]) cost += 5000;
    starts.set(base, it.start);
  }
  return cost + (r.missingMust?.length || 0) * 5000;
}

// Locked rides keep their index in the open part; everything else is free to be re-merged around them.
function splitLocks(open, locks) {
  const fixedAt = new Map();
  open.forEach((id, i) => { if (locks?.[id] && rideAt(id)) fixedAt.set(i, id); });
  return { fixedAt, free: open.filter((id, i) => !fixedAt.has(i)) };
}
function mergeLocks(free, fixedAt, n) {
  const out = []; let k = 0;
  for (let i = 0; i < n; i++) out.push(fixedAt.has(i) ? fixedAt.get(i) : free[k++]);
  while (k < free.length) out.push(free[k++]);
  return out.filter(Boolean);
}

/**
 * Re-order the rides of a plan for the shortest walk + wait (relocation + segment reversal, a few passes).
 * Meals/shows keep their relative order; locked rides keep their slot; done items stay in front.
 * Returns { seq, cost, before }.
 */
export function optimizeOrder(ctx, seq, locks = {}) {
  const done = seq.filter((id) => ctx.done?.[id]);
  const open = seq.filter((id) => !ctx.done?.[id]);
  const { fixedAt, free } = splitLocks(open, locks);
  const n = open.length;
  const full = (f) => [...done, ...mergeLocks(f, fixedAt, n)];
  let best = free, bestCost = planCost(ctx, full(free));
  const before = bestCost;
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    // 1) move one ride to another position
    for (const id of [...best]) {
      if (!rideAt(id)) continue;
      const rest = best.filter((x) => x !== id);
      for (let i = 0; i <= rest.length; i++) {
        const f = [...rest.slice(0, i), id, ...rest.slice(i)];
        const c = planCost(ctx, full(f));
        if (c < bestCost - 0.5) { best = f; bestCost = c; improved = true; }
      }
    }
    // 2) reverse a run of rides (fixes zig-zags: A→B→C becomes C→B→A when that walks less)
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 2; j < Math.min(best.length, i + 7); j++) {
        const seg = best.slice(i, j + 1);
        if (!seg.every((x) => rideAt(x))) break;
        const f = [...best.slice(0, i), ...seg.reverse(), ...best.slice(j + 1)];
        const c = planCost(ctx, full(f));
        if (c < bestCost - 0.5) { best = f; bestCost = c; improved = true; }
      }
    }
    if (!improved) break;
  }
  return { seq: full(best), cost: bestCost, before };
}

/** Put each missing must-ride where it costs least (it must be IN the day; where is up to the route). */
export function insertMissing(ctx, seq, ids) {
  let out = [...seq];
  for (const id of ids) {
    if (out.includes(id)) continue;
    const done = out.filter((x) => ctx.done?.[x]);
    const open = out.filter((x) => !ctx.done?.[x]);
    let best = null;
    for (let i = 0; i <= open.length; i++) {
      const o = [...done, ...open.slice(0, i), id, ...open.slice(i)];
      const c = planCost(ctx, o);
      if (!best || c < best.c) best = { c, o };
    }
    out = best.o;
  }
  return out;
}

/**
 * After "乗った": choose only the NEXT stop again (from where you are now, with today's waits) among the
 * rides planned before the next meal/show. Everything after it keeps its order. Locked rides never move.
 * Returns the new sequence (same array contents) — unchanged when nothing is clearly better (≥ minGain min).
 */
export function pickNext(ctx, seq, locks = {}, minGain = 3) {
  const done = seq.filter((id) => ctx.done?.[id]);
  const open = seq.filter((id) => !ctx.done?.[id]);
  const first = open.findIndex((id) => rideAt(id) && availability(rideAt(id), ctx).ok);
  if (first < 0) return seq;
  // only rides before the first meal/show (and before any locked ride) are candidates
  const cands = [];
  for (let i = first; i < open.length && cands.length < 5; i++) {
    const id = open[i];
    if (!rideAt(id) || locks[id]) break;
    if (availability(rideAt(id), ctx).ok) cands.push(i);
  }
  if (cands.length < 2 || locks[open[first]]) return seq;
  const cur = planCost(ctx, seq);
  let best = { c: cur - minGain, s: seq };
  for (const i of cands.slice(1)) {
    const o = [...open]; const [id] = o.splice(i, 1); o.splice(first, 0, id);
    const s = [...done, ...o];
    const c = planCost(ctx, s);
    if (c < best.c) best = { c, s };
  }
  return best.s;
}

// ---------- full plan optimisation (which rides + their order) ----------
// Each ride is worth "minutes" (popularity + your priority, scaled by the pace); the plan minimises
// cost (walking, queueing, meals moved, shows reached late, rides past closing) minus the value of the
// rides it includes. Must-rides are always included — WHEN they go is decided by the same cost
// (lowest predicted wait / shortest walk), not by putting them first.
const PACE_VALUE = { relax: 0.65, balance: 1, rides: 1.35 };
export const rideValue = (a, ctx) => (15 + a.pop * 12 + (PRIORITY[a.id] || 0)) * (PACE_VALUE[ctx.planId] ?? 1);
export function planScore(ctx, seq) {
  const r = planFromOrder(ctx, seq);
  let v = 0;
  for (const it of r.items) if (it.type === 'ride' && !it.over && !it.paused) v += rideValue(it.a, ctx);
  return planCost(ctx, seq) - v;
}
function bestInsert(ctx, full, base, id, bound) {
  let bo = null, bs = bound;
  for (let i = 0; i <= base.length; i++) {
    // No candidate may be inserted ahead of the next destination chosen by the user.
    if (ctx.firstRide && base[0] === ctx.firstRide && i === 0) continue;
    const o = [...base.slice(0, i), id, ...base.slice(i)];
    const sc = planScore(ctx, full(o));
    if (sc < bs) { bs = sc; bo = o; }
  }
  return bo ? { o: bo, s: bs } : null;
}
function localSearch(ctx, seq0, { locks = {}, pool = [], deadline = Infinity, keep = false } = {}) {
  const must = mustOf(ctx);
  const done = seq0.filter((x) => ctx.done?.[x]);
  let open = seq0.filter((x) => !ctx.done?.[x]);
  const full = (o) => [...done, ...o];
  const movable = (id) => !!rideAt(id) && !locks[id];
  let best = planScore(ctx, full(open));
  const take = (r) => { if (r) { open = r.o; best = r.s; return true; } return false; };
  for (let pass = 0; pass < 8 && Date.now() < deadline; pass++) {
    let improved = false;
    for (const id of pool) if (!open.includes(id) && take(bestInsert(ctx, full, open, id, best - 0.5))) improved = true;
    for (const id of keep ? [] : [...open]) {
      if (!movable(id) || must[id]) continue;
      const o = open.filter((x) => x !== id), sc = planScore(ctx, full(o));
      if (sc < best - 0.5) { open = o; best = sc; improved = true; }
    }
    for (const id of [...open]) if (movable(id) && take(bestInsert(ctx, full, open.filter((x) => x !== id), id, best - 0.5))) improved = true;
    for (const id of keep ? [] : [...open]) {
      if (Date.now() > deadline) break;
      if (!movable(id) || must[id] || !open.includes(id)) continue;
      const rest = open.filter((x) => x !== id);
      let r = null;
      for (const nid of pool) if (!open.includes(nid)) { const t = bestInsert(ctx, full, rest, nid, r ? r.s : best - 0.5); if (t) r = t; }
      if (take(r)) improved = true;
    }
    for (let i = 0; i < open.length; i++) for (let j = i + 2; j < Math.min(open.length, i + 7); j++) {
      const seg = open.slice(i, j + 1);
      if (!seg.every(movable)) break;
      const o = [...open.slice(0, i), ...seg.reverse(), ...open.slice(j + 1)], sc = planScore(ctx, full(o));
      if (sc < best - 0.5) { open = o; best = sc; improved = true; }
    }
    if (!improved) break;
  }
  return { seq: full(open), score: best };
}
/**
 * Decide which rides go into the day and in what order. seq0 = a starting sequence (rides + meals/shows).
 * opts: { locks, budgetMs, pool } — pool = ride ids that may be added (default: every ride that is open
 * now, not done, not excluded and not an "extra"). Deterministic for the same input.
 */
export function optimizePlan(ctx, seq0, opts = {}) {
  const t0 = Date.now(), budget = opts.budgetMs ?? 600, deadline = t0 + budget * 1.5;
  const pool = opts.pool || ATTRACTIONS.filter((a) => !a.extra && !ctx.done?.[a.id] && !ctx.excluded?.[a.id] && availability(a, ctx).ok).map((a) => a.id);
  const locks = opts.locks || {};
  let best = localSearch(ctx, seq0, {locks, pool, deadline, keep: opts.keep});
  // Multiple starts reduce sensitivity to the greedy seed. Propose nearby first legs, but
  // accept them only when the complete, time-constrained day is actually better.
  if (ctx.pos && !ctx.firstRide && Date.now() < deadline) {
    const done = seq0.filter((id) => ctx.done?.[id]);
    const open = seq0.filter((id) => !ctx.done?.[id]);
    const near = pool.filter((id) => !locks[id])
      .sort((a,b) => walkMin(ctx.pos, ctx.coords?.[a] || attractionById[a]?.pos) - walkMin(ctx.pos, ctx.coords?.[b] || attractionById[b]?.pos)).slice(0,4);
    for (const id of near) {
      if (Date.now() >= deadline) break;
      const seed = [...done, id, ...open.filter((x) => x !== id)];
      const r = localSearch(ctx, seed, {locks, pool, deadline, keep: opts.keep});
      if (r.score < best.score - 0.5) best = r;
    }
  }
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const must = mustOf(ctx);
  while (Date.now() - t0 < budget) {
    const cand = best.seq.filter((x) => attractionById[x] && !ctx.done?.[x] && !must[x] && !locks[x] && x !== ctx.firstRide);
    if (cand.length < 2 || opts.keep) break;
    const drop = new Set();
    for (let k = 0; k < 2; k++) drop.add(cand.splice(Math.floor(rnd() * cand.length), 1)[0]);
    const r = localSearch(ctx, best.seq.filter((x) => !drop.has(x)), {locks, pool, deadline});
    if (r.score < best.score - 0.5) best = r;
  }
  if (ctx.firstRide && best.seq.includes(ctx.firstRide)) {
    const done = best.seq.filter((id) => ctx.done?.[id]);
    best.seq = [...done, ctx.firstRide, ...best.seq.filter((id) => !ctx.done?.[id] && id !== ctx.firstRide)];
    best.score = planScore(ctx, best.seq);
  }
  return best;
}

export const _test = { scoreRide, stripDown };

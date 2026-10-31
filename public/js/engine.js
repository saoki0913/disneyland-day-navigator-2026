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
      start: ov.at ?? m.at, end: (ov.at ?? m.at) + m.dur, claim: 0,
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
  // The user's own ride order (drag & drop on the plan): the first ordered ride that still
  // fits before the next fixed block. Rides that don't fit yet come after that block.
  if (!result.primary && ctx.order?.length) {
    for (const id of ctx.order) {
      const c = cands.find((x) => x.a.id === id);
      if (!c) continue;
      c.reasons = [{ k: 'order', t: 'あなたが決めた順番' }, ...c.reasons.filter((x) => x.k !== 'order')];
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

export const _test = { scoreRide, stripDown };

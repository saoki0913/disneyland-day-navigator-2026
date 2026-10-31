import {
  TRIP, LANDS, landById, ATTRACTIONS, attractionById, RESTAURANTS, restaurantById, POPCORN, SHOWS, showById, PLANS, PRIORITY,
} from './data.js';
import {
  recommend, simulateDay, planFromOrder, bestInsert, buildAnchors, anchorConflicts, crowdRatio, walkMin, distanceM, hhmm, parseHHMM, estimateWait, availability, DEFAULT_MUST,
} from './engine.js';

// =====================================================================
// State (persisted in localStorage — never sent anywhere)
// =====================================================================
const KEY = 'dlnavi-1031-v1';
const defaults = {
  plan: 'balance',
  done: {},            // { rideId | 'meal:lunch' | 'show:fantasmic': timestampMs }
  doneMin: {},         // { id: park-local minutes when completed } (for the timeline)
  excluded: {},        // rides the user removed for today
  skip: {},            // { rideId: untilMin } — "別の候補" (temporary)
  manual: {},          // { rideId: { wait, at } } — user-entered wait from the official app
  prefs: { mealOverrides: {}, shows: {}, showTimes: {} },
  must: null,          // { rideId: true } rides the user must ride (null → both Star Wars rides)
  cond: { maxWait: 60, walk: 'normal' }, // plan conditions (crowd tolerance / walking)
  gps: false,          // user explicitly enabled GPS
  land: null,          // manual "I'm around here" land id
  landAt: 0,
  lastDone: null,      // { id, at }
  sim: null,           // { base: minutes, setAt: ms } — time simulation for testing
  pin: null,           // { id, until } destination chosen from an alert
  order: null,         // null = おまかせ (engine re-optimises) / [ids] = the user's own plan order
  a2hsDismissed: false,
  exploreTab: 'rides', exploreFilter: 'all', exploreSort: 'reco', foodFilter: 'all',
  mapFilter: 'rides',
  tab: 'home',
};
let S = load();
function load() {
  try { return deepMerge(structuredClone(defaults), JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return structuredClone(defaults); }
}
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') a[k] = deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage full / private mode */ } }

// Runtime (not persisted except caches)
const R = {
  live: null, liveStatus: 'idle', liveError: null, liveReceivedAt: 0,
  meta: null, photos: {},
  gpsPos: null, gpsErr: null, gpsWatch: null,
  lastPlanIds: null,
  hist: {},            // { rideId: [[min, wait|null], ...] } today's observed waits (this device)
  alerts: [],          // [{ id, type:'reopen'|'drop', from, to, at }]
  noteSeen: new Set(), // notices already shown once as a snackbar
  progOpen: false, planEdit: false, addMode: 'best',
};
try {
  const c = JSON.parse(localStorage.getItem(KEY + ':live') || 'null');
  if (c?.data) { R.live = c.data; R.liveReceivedAt = c.at; }
  const m = JSON.parse(localStorage.getItem(KEY + ':meta') || 'null');
  if (m && Date.now() - m.at < 12 * 3600e3) R.meta = m.data;
  const p = JSON.parse(localStorage.getItem(KEY + ':photos') || 'null');
  if (p && Date.now() - p.at < 3 * 86400e3 && p.data && Object.values(p.data)[0]?.source) R.photos = p.data;
  const h = JSON.parse(localStorage.getItem(KEY + ':hist') || 'null');
  if (h?.date === TRIP.date) R.hist = h.data || {};
} catch { /* ignore */ }

// =====================================================================
// Helpers
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jw = (s) => esc(s).replace(/・/g, '・<wbr>');
const fmtDur = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}` : `${m}分`; };

function laParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: TRIP.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const s = f.format(d); // "2026-10-31 07:55:12"
  const [date, time] = s.split(' ');
  const [h, m, sec] = time.split(':').map(Number);
  return { date, min: (h % 24) * 60 + m + sec / 60 };
}
function nowMin() {
  if (S.sim) return S.sim.base + (Date.now() - S.sim.setAt) / 60000;
  const p = laParts();
  if (p.date < TRIP.date) return TRIP.openMin - 60; // before the trip day: preview as morning
  if (p.date > TRIP.date) return 24 * 60;
  return p.min;
}
function dayPhase() {
  const p = laParts();
  if (S.sim) return 'sim';
  if (p.date < TRIP.date) return 'before';
  if (p.date > TRIP.date) return 'after';
  return 'today';
}
function hours() {
  const op = R.meta?.schedule?.operating;
  if (op && op.open != null && op.close != null) return { open: op.open, close: op.close === 0 ? 24 * 60 : op.close, src: 'api' };
  return { open: TRIP.openMin, close: TRIP.closeMin, src: 'plan' };
}
const clock = (m) => { const h = Math.floor(m / 60) % 24; return `${h}:${String(Math.floor(m % 60)).padStart(2, '0')}`; };

function coordsOf(id) {
  const c = R.meta?.coords?.[id];
  if (c) return { lat: c.lat, lon: c.lon, src: 'api' };
  const a = attractionById[id] || restaurantById[id];
  if (a?.pos) return { ...a.pos, src: 'approx' };
  const s = showById[id];
  if (s?.venuePos) return { ...s.venuePos, src: 'approx' };
  return null;
}
const coordsMap = () => {
  const out = {};
  for (const a of ATTRACTIONS) out[a.id] = coordsOf(a.id);
  return out;
};

// ---------- position ----------
const PARK_CENTER = { lat: 33.8121, lon: -117.9200 };
function position() {
  const now = Date.now();
  const g = R.gpsPos;
  if (S.gps && g && now - g.at < 5 * 60e3) {
    const d = distanceM(g, PARK_CENTER);
    if (d < 700) return { lat: g.lat, lon: g.lon, src: 'gps', acc: g.acc, label: `GPS（精度 約${Math.round(g.acc)}m）`, weak: g.acc > 80 };
    return { ...TRIP.entrance, src: 'outside', acc: g.acc, label: `パーク外（入口から約${Math.round(distanceM(g, TRIP.entrance))}m）→ 入口から計算` };
  }
  const recentDone = S.lastDone && now - S.lastDone.at < 90 * 60e3 ? S.lastDone : null;
  const recentLand = S.land && now - S.landAt < 90 * 60e3 ? S.land : null;
  if (recentLand && (!recentDone || S.landAt > recentDone.at)) {
    const l = landById[recentLand];
    return { ...l.pos, src: 'land', label: `${l.ja}（手動で選択・エリア中心で計算）` };
  }
  if (recentDone) {
    const c = coordsOf(recentDone.id) || anchorPos(recentDone.id);
    const name = attractionById[recentDone.id]?.short || recentDone.id;
    if (c) return { lat: c.lat, lon: c.lon, src: 'last', label: `最後に体験した「${name}」付近と仮定` };
  }
  if (nowMin() < hours().open + 10) return { ...TRIP.entrance, src: 'entrance', label: 'パーク入口（開園前の想定）' };
  return { lat: null, lon: null, src: 'none', label: '現在地が未設定（距離は概算）' };
}
function anchorPos(id) {
  if (id?.startsWith('meal:')) { const a = anchors().find((x) => x.id === id); return a?.pos; }
  if (id?.startsWith('show:')) return showById[id.slice(5)]?.venuePos;
  return null;
}

// ---------- live data ----------
function liveAgeMin() { return R.liveReceivedAt ? (Date.now() - Date.parse(R.live?.fetchedAt || R.liveReceivedAt)) / 60000 : Infinity; }
function liveIsFresh() { return R.live?.ok && liveAgeMin() <= 15 && !R.live?.stale; }
function liveMap() {
  const out = {};
  if (liveIsFresh()) for (const [id, v] of Object.entries(R.live.attractions || {})) out[id] = { ...v, kind: 'live' };
  // user-entered waits override for 30 min
  for (const [id, m] of Object.entries(S.manual || {})) {
    if (Date.now() - m.at < 30 * 60e3) out[id] = { ...(out[id] || {}), status: 'OPERATING', wait: m.wait, kind: 'manual' };
  }
  return out;
}
function waitInfo(a, at = nowMin()) {
  const lm = liveMap()[a.id];
  const raw = R.live?.attractions?.[a.id];
  if (lm?.kind === 'manual') return { wait: lm.wait, kind: 'manual', status: 'OPERATING' };
  if (lm && lm.status === 'OPERATING' && Number.isFinite(lm.wait)) return { wait: lm.wait, kind: 'live', status: 'OPERATING' };
  if (lm && lm.status && lm.status !== 'OPERATING' && nowMin() >= hours().open) return { wait: null, kind: 'live', status: lm.status };
  const crowd = crowdRatio(liveMap(), at);
  const est = Math.max(5, Math.round((estimateWait(a, Math.max(at, hours().open)) * crowd) / 5) * 5);
  return { wait: est, kind: 'est', status: raw?.status || null, staleWait: raw && !liveIsFresh() ? raw.wait : null };
}
const KIND_LABEL = { live: 'LIVE', manual: '手入力', est: '推定' };
const kindTag = (k) => `<span class="tag tag--${k}">${KIND_LABEL[k]}</span>`;
const waitClass = (w) => (w == null ? '' : w <= 20 ? 'is-good' : w <= 50 ? 'is-mid' : 'is-bad');
const STATUS_JA = { OPERATING: '運営中', DOWN: '一時休止', CLOSED: '休止・営業時間外', REFURBISHMENT: 'リニューアル休止' };

async function fetchLive({ manual = false } = {}) {
  if (R.liveStatus === 'loading') return;
  R.liveStatus = 'loading'; renderStatus();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch('/api/live', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.errors?.join(' / ') || `HTTP ${res.status}`);
    if (!j.stale) { detectAlerts(R.live?.ok && !R.live.stale ? R.live : null, j); recordHistory(j); }
    R.live = j; R.liveReceivedAt = Date.now(); R.liveStatus = j.stale ? 'stale' : 'ok'; R.liveError = j.stale ? (j.errors || []).join(' / ') : null;
    localStorage.setItem(KEY + ':live', JSON.stringify({ at: R.liveReceivedAt, data: j }));
    if (manual) toast(j.stale ? '最新取得に失敗：前回の値を表示中' : `待ち時間を更新しました（${j.sourceLabel}）`, j.stale ? 'error' : 'ok');
  } catch (e) {
    R.liveStatus = 'error';
    R.liveError = e.name === 'AbortError' ? 'タイムアウト' : e.message;
    if (manual) toast('待ち時間を取得できませんでした。推定値で案内します', 'error');
  }
  renderAll();
}
function recordHistory(j) {
  const m = Math.round(nowMin());
  for (const [id, v] of Object.entries(j.attractions || {})) {
    const arr = (R.hist[id] ||= []);
    const last = arr[arr.length - 1];
    const w = v.status === 'OPERATING' && Number.isFinite(v.wait) ? v.wait : null;
    if (last && Math.abs(last[0] - m) < 2) { last[1] = w; continue; }
    arr.push([m, w]);
    if (arr.length > 300) arr.shift();
  }
  try { localStorage.setItem(KEY + ':hist', JSON.stringify({ date: TRIP.date, data: R.hist })); } catch { /* full */ }
}
// Compare with the previous LIVE sample: a closed ride reopening, or a sudden wait drop.
function detectAlerts(prev, next) {
  if (!prev?.attractions || nowMin() < hours().open) return;
  const fresh = [];
  for (const [id, v] of Object.entries(next.attractions || {})) {
    const a = attractionById[id], p0 = prev.attractions[id];
    if (!a || !p0 || S.done[id] || S.excluded[id]) continue;
    if (p0.status !== 'OPERATING' && v.status === 'OPERATING' && p0.status !== 'REFURBISHMENT') fresh.push({ id, type: 'reopen', to: v.wait });
    else if (v.status === 'OPERATING' && Number.isFinite(p0.wait) && Number.isFinite(v.wait) && p0.wait - v.wait >= 15 && v.wait <= p0.wait * 0.7 && (a.pop >= 4 || a.must)) fresh.push({ id, type: 'drop', from: p0.wait, to: v.wait });
  }
  if (!fresh.length) return;
  fresh.sort((x, y) => (attractionById[y.id].must - attractionById[x.id].must) || (PRIORITY[y.id] || 0) - (PRIORITY[x.id] || 0));
  const now = nowMin();
  R.alerts = [...fresh.map((f) => ({ ...f, at: now })), ...R.alerts.filter((x) => !fresh.some((f) => f.id === x.id))].slice(0, 3);
  try { navigator.vibrate?.([180, 80, 180]); } catch { /* unsupported (iOS) */ }
}
const activeAlerts = () => R.alerts.filter((x) => nowMin() - x.at < 20 && !S.done[x.id]);

async function fetchMeta() {
  try {
    const res = await fetch('/api/meta');
    const j = await res.json();
    if (j?.ok) { R.meta = j; localStorage.setItem(KEY + ':meta', JSON.stringify({ at: Date.now(), data: j })); renderAll(); }
  } catch { /* fallback coords stay in use */ }
}
async function fetchPhotos() {
  if (Object.keys(R.photos).length > 20) return;
  const sets = await Promise.allSettled(['rides', 'food', 'shows'].map((set) => fetch('/api/photos?set=' + set).then((r) => r.json())));
  const merged = { ...R.photos };
  for (const s2 of sets) if (s2.status === 'fulfilled' && s2.value?.ok) Object.assign(merged, s2.value.photos);
  if (Object.keys(merged).length) {
    R.photos = merged;
    localStorage.setItem(KEY + ':photos', JSON.stringify({ at: Date.now(), data: merged }));
    renderAll();
  }
}
const credit = (key) => { const p = R.photos?.[key]; if (!p) return ''; return `Photo: ${[p.author, p.license].filter(Boolean).join(' · ') || p.title} / ${p.source || 'Wikimedia'}`; };

// ---------- GPS ----------
function startGPS(userInitiated = false) {
  if (!('geolocation' in navigator)) { R.gpsErr = 'この端末・ブラウザは位置情報に対応していません'; renderAll(); return; }
  if (R.gpsWatch != null) navigator.geolocation.clearWatch(R.gpsWatch);
  R.gpsErr = null;
  if (userInitiated) toast('位置情報の許可を確認しています…');
  R.gpsWatch = navigator.geolocation.watchPosition((p) => {
    const first = !R.gpsPos;
    R.gpsPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
    if (!S.gps) { S.gps = true; save(); }
    if (first && userInitiated) toast(`現在地を取得しました（精度 約${Math.round(p.coords.accuracy)}m）`, 'ok');
    renderAll();
  }, (err) => {
    R.gpsErr = err.code === 1 ? '位置情報が許可されていません（設定から許可するか、エリアを手動で選んでください）' : err.code === 3 ? '位置情報の取得がタイムアウトしました' : '位置情報を取得できませんでした';
    if (err.code === 1) { S.gps = false; save(); if (R.gpsWatch != null) navigator.geolocation.clearWatch(R.gpsWatch); R.gpsWatch = null; }
    if (userInitiated) toast(R.gpsErr, 'error');
    renderAll();
  }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
}
function stopGPS() {
  if (R.gpsWatch != null) navigator.geolocation.clearWatch(R.gpsWatch);
  R.gpsWatch = null; R.gpsPos = null; S.gps = false; save(); renderAll();
  toast('位置情報の利用を停止しました');
}

// ---------- engine context ----------
function showTimesFor(id) {
  const manual = S.prefs.showTimes?.[id];
  if (manual?.length) return { times: manual, src: 'manual' };
  const api = R.live?.shows?.[id]?.times?.filter((t) => !t.date || t.date === TRIP.date).map((t) => hhmm(t.start));
  if (api?.length) return { times: [...new Set(api)], src: 'api' };
  return { times: showById[id].times, src: 'pre' };
}
function anchors() {
  const showTimes = {};
  for (const s of SHOWS) showTimes[s.id] = showTimesFor(s.id).times;
  return buildAnchors(S.plan, { ...S.prefs, showTimes }, S.done);
}
const mustMap = () => S.must || { ...DEFAULT_MUST };
function ctx(extra = {}) {
  const h = hours();
  const live = liveMap();
  const now = nowMin();
  return {
    now, openMin: h.open, closeMin: h.close, pos: (() => { const p = position(); return p.lat == null ? null : p; })(),
    planId: S.plan, done: S.done, excluded: S.excluded, skip: S.skip, live, crowd: crowdRatio(live, now),
    anchors: anchors(), coords: coordsMap(), pin: S.pin, must: mustMap(), cond: S.cond, ...extra,
  };
}

// ---------- plan: おまかせ (auto, re-optimised live) or the user's own order ----------
const PLAN_TYPES = ['ride', 'meal', 'show'];
function planOf(c = ctx()) { return S.order ? planFromOrder(c, S.order) : simulateDay(c); }
function orderFromPlan(sim) { return sim.items.filter((i) => PLAN_TYPES.includes(i.type)).map((i) => i.id); }
// First edit turns the current auto plan into an editable list.
function ensureOrder() { if (!S.order) S.order = orderFromPlan(simulateDay(ctx())); return S.order; }
const snapshot = () => ({ order: S.order ? [...S.order] : null, prefs: structuredClone(S.prefs), pin: S.pin });
function restore(sn) { S.order = sn.order; S.prefs = sn.prefs; S.pin = sn.pin; save(); renderAll(); }
const itemName = (id) => attractionById[id]?.short || (id.startsWith('meal:') ? (PLANS[S.plan].meals.find((m) => 'meal:' + m.id === id)?.ja || 'ごはん') : showById[id.slice(5)]?.short || id);
const isOpenItem = (i) => PLAN_TYPES.includes(i.type) && !i.blocked && !i.over && i.anchor?.late !== 'miss';
// Next action: in manual mode it is simply the first open item of the user's plan.
function homeReco(c) {
  const r = recommend(c);
  if (!S.order) return r;
  const plan = planFromOrder(c, S.order);
  const open = plan.items.filter(isOpenItem);
  const first = open[0];
  if (!first) return { ...r, plan };
  const nx = open[1];
  const next = nx && { id: nx.id, title: nx.a ? nx.a.short : nx.anchor.title, start: nx.start, claim: nx.type === 'show' ? nx.start - nx.claimFrom : 0, pos: nx.a ? coordsOf(nx.a.id) : nx.anchor.pos };
  const primary = first.type === 'ride'
    ? { type: 'ride', a: first.a, walk: first.walk, wait: first.wait, kind: first.waitKind, finish: first.end, reasons: [{ k: 'mine', t: 'あなたのプランの順番' }, ...(first.wait <= 20 ? [{ k: 'short', t: '' }] : [])] }
    : { type: 'anchor', anchor: first.anchor, walk: first.walk };
  return { ...r, primary, next, alts: r.alts.filter((x) => x.a.id !== first.id), plan };
}
function addToPlan(id, mode = 'best') {
  const sn = snapshot();
  ensureOrder();
  if (id.startsWith('meal:')) { const m = id.slice(5); S.prefs.mealOverrides[m] = { ...(S.prefs.mealOverrides[m] || {}), off: false }; }
  if (id.startsWith('show:')) { const x = id.slice(5); S.prefs.shows[x] = { ...(S.prefs.shows[x] || {}), on: true }; }
  let o = S.order.filter((x) => x !== id && !S.done[x]);
  o = mode === 'next' ? [id, ...o] : bestInsert(ctx(), o, id);
  S.order = o; delete S.excluded[id];
  save(); renderAll();
  toast(mode === 'next' ? `${itemName(id)} を次の行き先にしました` : `${itemName(id)} を${o.indexOf(id) + 1}番目に追加`, 'ok', { label: '元に戻す', fn: () => restore(sn) });
}
function removeFromPlan(id) {
  const sn = snapshot();
  ensureOrder();
  S.order = S.order.filter((x) => x !== id);
  if (id.startsWith('meal:')) { const m = id.slice(5); S.prefs.mealOverrides[m] = { ...(S.prefs.mealOverrides[m] || {}), off: true }; }
  if (id.startsWith('show:')) { const x = id.slice(5); S.prefs.shows[x] = { ...(S.prefs.shows[x] || {}), on: false }; }
  save(); renderAll();
  toast(`${itemName(id)} をプランから外しました`, '', { label: '元に戻す', fn: () => restore(sn) });
}
function moveInPlan(id, dir) {
  ensureOrder();
  const vis = S.order.filter((x) => !S.done[x]);
  const i = vis.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= vis.length) return;
  [vis[i], vis[j]] = [vis[j], vis[i]];
  S.order = vis; save(); renderAll();
}


// =====================================================================
// Icons (simple line icons instead of emoji)
// =====================================================================
const IC = {
  walk: '<circle cx="13" cy="4.5" r="2"/><path d="M9 21l2.5-7 3 3V21M7.5 12l3-4h3l2.5 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4h12l-2.5 4L17 12H5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  pin: '<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  route: '<path d="m3 11 18-8-8 18-2-8Z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  food: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 8h3"/>',
  show: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  locate: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  ride: '<path d="M3 19c2.5-8 5.5-13 9-13s6.5 5 9 13M3 19h18"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const ic = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${IC[k] || ''}</svg>`;

// =====================================================================
// Images: Wikipedia photo when available, otherwise a plain initials tile
// =====================================================================
const initials = (name) => String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !/^(the|of|and|a)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '★';
function poster(name, color) {
  return `<div class="poster" style="--c:${color || 'var(--navy)'}">${esc(initials(name))}</div>`;
}
function imgFor(key, { name, color } = {}) {
  const p = R.photos?.[key];
  const fb = esc(JSON.stringify({ name, color }));
  if (p?.src) return `<img class="img" loading="lazy" decoding="async" src="${esc(p.src)}" alt="${esc(name)}の写真" data-fb="${fb}">`;
  return poster(name, color);
}
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t?.tagName === 'IMG' && t.dataset.fb) {
    try { const f = JSON.parse(t.dataset.fb); t.outerHTML = poster(f.name, f.color); } catch { t.remove(); }
  }
}, true);
const rideImg = (a) => imgFor(a.id, { name: a.en, color: landById[a.land]?.color });
const foodImg = (r) => imgFor('food_' + r.id, { name: r.en, color: '#2e6b4f' });
const showImgKey = (id) => (id === 'fantasmic' ? 'fantasmic' : id === 'fireworks' ? 'fireworks' : 'cavalcade');
const showImg = (s) => imgFor(showImgKey(s.id), { name: s.en, color: '#5b3f78' });

// =====================================================================
// UI primitives
// =====================================================================
let toastTimer;
function toast(msg, type = '', action = null) {
  const el = $('#toast');
  el.className = 'toast is-on' + (type ? ' is-' + type : '');
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="linkbtn" id="toastAct">${esc(action.label)}</button>` : '');
  el.style.pointerEvents = action ? 'auto' : 'none';
  if (action) $('#toastAct').onclick = () => { action.fn(); el.className = 'toast'; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; el.style.pointerEvents = 'none'; }, action ? 5500 : 2600);
}
function openSheet(html, { keepScroll = false } = {}) {
  const panel = $('.sheet__panel');
  const top = keepScroll ? panel.scrollTop : 0;
  $('#sheetBody').innerHTML = `<button class="sheet__close" data-close aria-label="閉じる">${ic('x')}</button>` + html;
  $('#sheet').hidden = false;
  panel.scrollTop = top;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; R.draft = null; }
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

const routeUrl = (pos) => `https://www.google.com/maps/dir/?api=1&destination=${pos.lat},${pos.lon}&travelmode=walking`;
const dots = (n, max = 5) => `<span aria-label="${n}/${max}" style="letter-spacing:1px">${'●'.repeat(n)}<span style="color:var(--line)">${'●'.repeat(max - n)}</span></span>`;
const doneRides = () => Object.keys(S.done).filter((k) => attractionById[k]);
const PACE = { relax: 'ゆったり', balance: 'ふつう', rides: 'たくさん' };

// =====================================================================
// Actions
// =====================================================================
function doneName(id) {
  if (attractionById[id]) return attractionById[id].short;
  const a = anchors().find((x) => x.id === id);
  if (a) return a.title + (a.kind === 'meal' && a.place ? `（${a.place}）` : '');
  if (id.startsWith('show:')) return showById[id.slice(5)]?.short || id;
  return '予定';
}
// Tap = complete immediately (with undo in the toast). Tapping a completed item asks before reverting.
function markDone(id) {
  if (S.done[id]) return openUndoConfirm(id);
  S.done[id] = Date.now();
  S.doneMin[id] = nowMin();
  S.lastDone = { id, at: Date.now() };
  delete S.skip[id];
  if (S.pin?.id === id) S.pin = null;
  save(); renderAll();
  const n = doneRides().length;
  toast(`${doneName(id)} 完了${attractionById[id] ? `（${n}つ目）` : ''}`, 'ok', { label: '取り消す', fn: () => undoDone(id, true) });
}
function undoDone(id, silent = false) {
  const prev = { at: S.done[id], min: S.doneMin[id] };
  delete S.done[id]; delete S.doneMin[id];
  if (S.lastDone?.id === id) S.lastDone = null;
  save(); renderAll();
  if (!silent) toast(`${doneName(id)} を未完了に戻しました`, '', { label: '完了に戻す', fn: () => { S.done[id] = prev.at; S.doneMin[id] = prev.min; save(); renderAll(); } });
}
function openUndoConfirm(id) {
  const m = S.doneMin[id];
  openSheet(`<div class="sheet__content" style="text-align:center">
    <h2 class="sheet__title" id="sheetTitle">${esc(doneName(id))}</h2>
    <p class="para muted">${m != null ? `<span class="num">${clock(m)}</span> に完了` : '完了済み'}</p>
    <div class="btnrow"><button class="btn" data-close>そのまま</button><button class="btn btn--primary" data-undo="${id}" data-close>未完了に戻す</button></div>
  </div>`);
}
function skipFor(id, minutes = 20) {
  if (S.order) {
    const sn = snapshot();
    moveInPlan(id, 1);
    return toast(`${attractionById[id]?.short || itemName(id)} を1つ後ろにしました`, '', { label: '戻す', fn: () => restore(sn) });
  }
  S.skip[id] = nowMin() + minutes; save(); renderAll();
  toast(`${attractionById[id]?.short} を${minutes}分間あとまわし`, '', { label: '戻す', fn: () => { delete S.skip[id]; save(); renderAll(); } });
}

// =====================================================================
// Render: status pill / banner / clock
// =====================================================================
function renderStatus() {
  const pill = $('#livePill'), txt = $('#livePillText');
  pill.className = 'pill';
  const age = liveAgeMin();
  if (R.liveStatus === 'loading') { pill.classList.add('is-loading'); txt.textContent = '更新中'; }
  else if (liveIsFresh()) { pill.classList.add('is-live'); txt.textContent = age < 1 ? 'LIVE' : `LIVE ${Math.round(age)}分前`; }
  else if (R.live?.ok) { pill.classList.add('is-stale'); txt.textContent = `${Math.round(age)}分前`; }
  else if (R.liveStatus === 'error') { pill.classList.add('is-error'); txt.textContent = '推定'; }
  else { txt.textContent = '推定'; }

  const b = $('#banner');
  const phase = dayPhase();
  let msg = '', err = false;
  if (phase === 'sim') msg = `テスト時刻 ${clock(nowMin())}`;
  else if (phase === 'before') msg = '当日の朝としてプレビュー中';
  else if (phase === 'after') msg = '10/31の営業は終了しました';
  if (R.liveStatus === 'error' && !R.live?.ok) { msg = (msg ? msg + ' / ' : '') + '待ち時間は推定'; err = true; }
  else if (R.live?.ok && !liveIsFresh()) { msg = (msg ? msg + ' / ' : '') + `待ち時間が${Math.round(age)}分前 · 推定で案内`; err = true; }
  b.hidden = !msg;
  b.className = 'banner' + (err ? ' is-error' : '');
  b.innerHTML = `<span>${esc(msg)}</span>` + (err ? `<button class="btn btn--sm" data-act="refresh">${ic('refresh')}再取得</button>` : '');
  document.documentElement.style.setProperty('--bnr', (b.hidden ? 0 : b.offsetHeight) + 'px');
}
function renderClock() {
  const m = nowMin();
  $('#clock').textContent = m >= 24 * 60 ? '--:--' : clock(m);
}

// Reason keys → short text tags
const RTAG = {
  must: ['絶対乗る', 'must'], dip: ['いつもより空き', 'live'], later: ['あとで混む', 'warn'], short: ['待ち短め', 'live'],
  near: ['すぐ近く', 'live'], pop: ['大人気', ''], fit: ['次の予定に間に合う', ''], bump: ['休憩を後ろへ', 'warn'],
  soft: ['場所取り短め', 'warn'], close: ['閉園前に並べばOK', 'warn'], pin: ['あなたが選択', 'must'], mine: ['あなたのプラン', 'must'],
};
const rtags = (reasons, max = 3) => `<div class="tags">${(reasons || []).slice(0, max).map((x) => {
  const [t, k] = RTAG[x.k] || [x.t, ''];
  return `<span class="tag ${k ? 'tag--' + k : ''}" title="${esc(x.t)}">${esc(t)}</span>`;
}).join('')}</div>`;

// Time bar: now → walk → wait → ride → spare → next fixed plan (visual instead of sentences)
function timeBar(start, parts, endLabel, endTime) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.m), 0) || 1;
  return `<div class="tbar"><div class="tbar__row">${parts.filter((p) => p.m > 0).map((p) => `<div class="tbar__seg tbar__seg--${p.k}" style="flex:${p.m} 1 0">${p.m / total > 0.13 ? esc(p.t) : ''}</div>`).join('')}</div>
    <div class="tbar__lbl"><span>いま <span class="num">${clock(start)}</span></span><span>${esc(endLabel)} <span class="num">${clock(endTime)}</span></span></div></div>`;
}
function trendOf(id) {
  const pts = (R.hist[id] || []).filter((p) => p[1] != null);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const ref = pts.filter((p) => p[0] <= last[0] - 20).pop() || pts[0];
  if (last[0] - ref[0] < 10) return null;
  const d = last[1] - ref[1];
  return { d, dir: d <= -10 ? 'down' : d >= 10 ? 'up' : 'flat', mins: last[0] - ref[0] };
}
const TREND = { down: ['↘', '減少中', 'var(--good)'], up: ['↗', '増加中', 'var(--bad)'], flat: ['→', '横ばい', 'var(--muted)'] };
function sparkSmall(id) {
  const pts = (R.hist[id] || []).filter((p) => p[1] != null);
  if (pts.length < 2) return '';
  const w = 70, h = 22, x0 = pts[0][0], x1 = Math.max(pts[pts.length - 1][0], x0 + 30);
  const ymax = Math.max(30, ...pts.map((p) => p[1]));
  const X = (m) => 2 + ((m - x0) / (x1 - x0)) * (w - 8), Y = (v) => h - 3 - (v / ymax) * (h - 6);
  const t = trendOf(id);
  const last = pts[pts.length - 1];
  return `<span class="spark" title="今日の待ち時間の推移"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <line x1="2" x2="${w - 2}" y1="${h - 3}" y2="${h - 3}" stroke="var(--line)" stroke-width="1"/>
    <polyline fill="none" stroke="var(--navy)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>
    <circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="3.5" fill="var(--red)" stroke="var(--card)" stroke-width="1.5"/></svg>${t ? `<b style="color:${TREND[t.dir][2]}">${TREND[t.dir][0]}</b>` : ''}</span>`;
}
function sparkBig(a) {
  const pts = (R.hist[a.id] || []);
  const h0 = hours();
  const W = 320, H = 130, L = 30, Rr = 8, T = 10, B = 22;
  const x0 = h0.open, x1 = h0.close;
  const est = [];
  for (let m = x0; m <= x1; m += 30) est.push([m, Math.round(estimateWait(a, m) * crowdRatio(liveMap(), nowMin()))]);
  const vals = [...pts.filter((p) => p[1] != null).map((p) => p[1]), ...est.map((p) => p[1])];
  const ymax = Math.max(30, Math.ceil(Math.max(...vals) / 30) * 30);
  const X = (m) => L + ((m - x0) / (x1 - x0)) * (W - L - Rr), Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const grid = [0, ymax / 2, ymax].map((v) => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end" class="ax">${v}</text>`).join('');
  const xt = [8, 12, 16, 20].filter((hh) => hh * 60 >= x0 && hh * 60 <= x1).map((hh) => `<text x="${X(hh * 60)}" y="${H - 6}" text-anchor="middle" class="ax">${hh}時</text>`).join('');
  // observed line, broken where the ride was closed (null)
  const segs = []; let cur = [];
  for (const p of pts) { if (p[1] == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
  if (cur.length) segs.push(cur);
  const live = segs.map((sg) => sg.length === 1 ? `<circle cx="${X(sg[0][0])}" cy="${Y(sg[0][1])}" r="3" fill="var(--navy)"/>` : `<polyline fill="none" stroke="var(--navy)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${sg.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>`).join('');
  const nowX = X(Math.min(x1, Math.max(x0, nowMin())));
  const lastP = pts.filter((p) => p[1] != null).pop();
  const data = esc(JSON.stringify({ pts: pts.filter((p) => p[1] != null), est, x0, x1, L, R: Rr, W }));
  return `<div class="bigspark" data-spark="${data}">
    <div class="bigspark__head"><b>待ち時間の推移</b><span class="bigspark__legend"><i class="lg lg--live"></i>今日の実測 <i class="lg lg--est"></i>推定</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(a.short)}の待ち時間の推移">
      ${grid}${xt}
      <polyline fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4" points="${est.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>
      ${live}
      <line x1="${nowX}" x2="${nowX}" y1="${T}" y2="${H - B}" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="2 3"/>
      ${lastP ? `<circle cx="${X(lastP[0])}" cy="${Y(lastP[1])}" r="5" fill="var(--red)" stroke="var(--card)" stroke-width="2"/>` : ''}
      <line class="bigspark__x" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--navy)" stroke-width="1" visibility="hidden"/>
    </svg>
    <div class="bigspark__tip">${pts.length ? 'グラフをなぞると時刻ごとの値' : 'アプリを開いている間の実測を記録していきます'}</div></div>`;
}
document.addEventListener('pointermove', sparkHover);
document.addEventListener('pointerdown', sparkHover);
function sparkHover(e) {
  const box = e.target.closest?.('.bigspark');
  if (!box) return;
  const d = JSON.parse(box.dataset.spark);
  const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
  const vx = ((e.clientX - r.left) / r.width) * d.W;
  const m = d.x0 + ((vx - d.L) / (d.W - d.L - d.R)) * (d.x1 - d.x0);
  if (m < d.x0 || m > d.x1) return;
  const near = (arr) => arr.reduce((b, p) => (!b || Math.abs(p[0] - m) < Math.abs(b[0] - m) ? p : b), null);
  const lp = near(d.pts), ep = near(d.est);
  const line = box.querySelector('.bigspark__x');
  line.setAttribute('x1', vx); line.setAttribute('x2', vx); line.setAttribute('visibility', 'visible');
  box.querySelector('.bigspark__tip').innerHTML = `<b>${clock(m)}</b>　${lp && Math.abs(lp[0] - m) <= 15 ? `実測 <b>${lp[1]}分</b>（${clock(lp[0])}）　` : ''}推定 ${ep ? ep[1] : '-'}分`;
}


// =====================================================================
// HOME
// =====================================================================
function renderHome() {
  const el = $('#view-home');
  const c = ctx();
  const h = hours();
  const done = doneRides();
  let html = '';

  if (c.now >= h.close || dayPhase() === 'after') {
    html += `<div class="card card--pad" style="text-align:center"><div class="kicker">See you again</div><h2 style="margin:4px 0">おつかれさま！</h2>
      <div class="prog__n" style="font-size:40px">${done.length}<small> 施設</small></div>
      <div class="tags" style="justify-content:center;margin-top:10px">${done.map((id) => `<span class="tag">${esc(attractionById[id].short)}</span>`).join('')}</div></div>`;
    el.innerHTML = html + footer();
    renderActionBar(null);
    return;
  }
  const r = homeReco(c);
  const sim = r.plan || simulateDay(c);

  // 1) next action
  html += renderNextCard(r, c);
  // 2) progress: a slim band, tap to expand
  html += progressBand(c, sim, done);
  if (c.now < h.open) {
    html += `<div class="card cdrow">${ic('clock')}<span>開園 <b class="num">${clock(h.open)}</b> まで <b>${fmtDur(h.open - c.now)}</b> · 入口に <span class="num">${clock(h.open - 40)}</span> 着が目安</span></div>`;
  }
  // 3) only actionable alerts stay on screen (reopened / suddenly shorter)
  for (const al of activeAlerts()) {
    const a = attractionById[al.id];
    html += `<div class="alert" role="alert"><div class="alert__body"><div class="alert__t">${esc(a.short)} ${al.type === 'reopen' ? '再開' : '空いてきた'}</div>
        <div class="alert__s">${al.type === 'reopen' ? `いま 待ち <span class="num">${al.to ?? '?'}</span>分` : `<s>${al.from}分</s> → <b class="num">${al.to}</b>分`}</div></div>
      <button class="btn btn--sm btn--primary" data-pin="${al.id}">行く</button><button class="alert__x" data-dismiss-alert="${al.id}" aria-label="閉じる">${ic('x')}</button></div>`;
  }
  // 4) other options
  if (r.alts.length) {
    const lbl = { wait: '待ち短い', walk: '近い', pop: '人気', score: '時間があれば' };
    html += `<div class="sec" id="alts"><h2><span class="sec__en">OTHERS</span>ほかの候補</h2></div><div class="card rows">`;
    html += r.alts.map((a) => `<button class="row" type="button" data-open="${a.a.id}">
        <span class="row__thumb">${rideImg(a.a)}</span>
        <span class="row__body"><span class="row__k">${esc(lbl[a.key] || a.label)}</span><span class="row__name">${jw(a.a.short)}</span>
          <span class="row__meta">${ic('walk')}${a.walk}分<span>${ic('flag')}<span class="num">${clock(a.finish)}</span></span></span></span>
        <span class="row__wait"><b class="${waitClass(a.wait)}">${a.wait}</b><small>分</small><br>${kindTag(a.kind)}</span></button>`).join('');
    html += `</div>`;
  }
  html += footer();
  el.innerHTML = html;
  renderActionBar(r);
  noteToasts(r, sim);
}

// Progress band: one slim line (done / planned + next fixed item); tap opens the detail inline.
function progressBand(c, sim, done) {
  const total = Math.max(done.length + sim.rides, done.length);
  const pct = Math.min(100, (done.length / Math.max(1, total)) * 100);
  const open = sim.items.filter(isOpenItem);
  const fixed = open.find((i) => i.type !== 'ride');
  const live = liveMap();
  const musts = Object.keys(mustMap()).filter((id) => attractionById[id]);
  const nm = (i) => (i.a ? i.a.short : i.anchor.title + (i.type === 'meal' && i.anchor.place ? `（${i.anchor.place.split('・')[0]}）` : ''));
  return `<div class="card pband ${R.progOpen ? 'is-open' : ''}">
    <button class="pband__h" type="button" data-act="prog-toggle" aria-expanded="${!!R.progOpen}">
      <span class="prog__n">${done.length}<small>/${total}</small></span>
      <span class="pband__bar"><i style="width:${pct}%"></i></span>
      <span class="pband__s">${fixed ? `<span class="num">${clock(fixed.start)}</span> ${esc(fixed.anchor.title)}` : `残り${Math.max(0, total - done.length)}`}</span>
      <span class="pband__chev">${ic('chev')}</span></button>
    ${R.progOpen ? `<div class="pband__body">
      ${musts.length ? `<div class="musts">${musts.map((id) => {
        const down = !S.done[id] && live[id] && live[id].status !== 'OPERATING' && c.now >= c.openMin;
        return `<span class="must ${S.done[id] ? 'is-done' : down ? 'is-down' : ''}">${S.done[id] ? ic('check') : ic('star')}${esc(attractionById[id].short)}${down ? '（休止）' : ''}</span>`;
      }).join('')}</div>` : ''}
      <ol class="mini">${open.slice(0, 6).map((i) => `<li class="mini__i mini__i--${i.type}"><span class="num">${clock(i.start)}</span><span class="mini__n">${esc(nm(i))}</span>${i.type === 'ride' ? `<span class="mini__w">待ち${i.wait}分</span>` : ''}</li>`).join('') || '<li class="mini__i">予定はもうありません</li>'}</ol>
      <button class="btn btn--sm btn--block" data-tab-go="plan">${ic('edit')}プランを見る・編集</button>
    </div>` : ''}
  </div>`;
}

// Non-actionable notices (休止中・入りきらない) appear once as a snackbar instead of staying on screen.
function noteToasts(r, sim) {
  const msgs = r.notes.map((n) => [`${n.id}:${n.fit ? 'fit' : n.temporary ? 'tmp' : 'off'}`, `${n.text}${n.fit ? '（あとで案内）' : n.temporary ? '（再開したら案内）' : ''}`]);
  if (sim.missingMust.length && !r.notes.length) msgs.push(['miss:' + sim.missingMust.join(), `${sim.missingMust.map((id) => attractionById[id].short).join('・')} がプランに入りきらない`]);
  const fresh = msgs.filter(([k]) => !R.noteSeen.has(k)).map(([k, m]) => (R.noteSeen.add(k), m));
  if (!fresh.length) return;
  const show = () => ($('#toast').classList.contains('is-on') ? setTimeout(show, 1500) : toast(fresh.join(' / '), 'warn', { label: 'プラン', fn: () => go('plan') }));
  setTimeout(show, 500);
}
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// Thumb-reach action bar (one-handed): the two most frequent actions, always at the bottom.
function renderActionBar(r) {
  let bar = $('#actionbar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'actionbar'; bar.className = 'actionbar'; document.body.appendChild(bar); }
  const p = r?.primary;
  const show = S.tab === 'home' && p && (p.type === 'ride' || p.type === 'anchor');
  bar.hidden = !show;
  document.body.classList.toggle('has-actionbar', !!show);
  if (!show) return;
  if (p.type === 'ride') {
    bar.innerHTML = `<button class="actionbar__side" data-skip="${p.a.id}" aria-label="別の候補">${ic('refresh')}別の候補</button>
      <button class="actionbar__main" data-done="${p.a.id}">${ic('check')}<span>${esc(p.a.short)} 乗った</span></button>`;
  } else {
    const x = p.anchor;
    bar.innerHTML = `<button class="actionbar__side" data-anchor-edit="${x.id}" aria-label="変更">${ic('edit')}変更</button>
      <button class="actionbar__main" data-done="${x.id}">${ic('check')}<span>${esc(x.title)} ${x.kind === 'show' ? '観た' : '食べた'}</span></button>`;
  }
}

function stat(k, icon, v, src = '') {
  return `<div class="stat"><div class="stat__k">${ic(icon)}${k}</div><div class="stat__v">${v}</div>${src ? `<div class="stat__src">${src}</div>` : ''}</div>`;
}
function renderNextCard(r, c) {
  const p = r.primary;
  const next = r.next;
  if (!p) return `<div class="card card--pad empty">候補を計算できませんでした</div>`;

  if (p.type === 'ride') {
    const a = p.a;
    const start = Math.max(c.now, c.openMin);
    const back = next ? walkMin(coordsOf(a.id), next.pos) : 0;
    const endT = next ? next.start - next.claim : Math.max(p.finish, c.closeMin);
    const slack = next ? Math.max(0, endT - p.finish - back) : 0;
    const bar = timeBar(start, [
      { k: 'walk', m: p.walk, t: `歩${p.walk}` }, { k: 'wait', m: p.wait, t: `待ち${p.wait}` }, { k: 'ride', m: a.dur, t: '乗る' }, { k: 'slack', m: slack + back, t: next ? '余裕' : '' },
    ], next ? next.title : '閉園', next ? next.start : c.closeMin);
    const t = trendOf(a.id);
    return `<article class="card next">
      <div class="next__head"><div class="next__thumb">${rideImg(a)}</div>
        <div style="min-width:0"><div class="kicker">Next · ${esc(landById[a.land]?.ja || '')}</div>
          <h1 class="next__title">${jw(a.short)}</h1><div class="next__en">${esc(a.en)}</div></div></div>
      <div class="stats">
        ${stat('待ち', 'clock', `<span class="${waitClass(p.wait)}">${p.wait}</span><small>分</small>`, kindTag(p.kind) + (t && t.dir !== 'flat' ? ` <b style="color:${TREND[t.dir][2]}">${TREND[t.dir][0]}</b>` : ''))}
        ${stat('徒歩', 'walk', `${p.walk}<small>分</small>`)}
        ${stat('終わる', 'flag', clock(p.finish))}
      </div>
      ${rtags(p.reasons)}
      ${bar}
      <div class="btnrow">
        <a class="btn" href="${routeUrl(coordsOf(a.id))}" target="_blank" rel="noopener">${ic('route')}ルート</a>
        <button class="btn" data-open="${a.id}">${ic('info')}くわしく</button>
      </div></article>`;
  }

  if (p.type === 'anchor') {
    const x = p.anchor;
    const isShow = x.kind === 'show';
    const s = isShow ? showById[x.show] : null;
    const rest = x.restaurant ? restaurantById[x.restaurant] : null;
    const tags = isShow
      ? [[s.venue.split('（')[0], '']]
      : [[`${fmtDur(x.end - x.start)}確保`, ''], rest.mobile === 'yes' ? ['モバイルオーダー可', 'live'] : rest.mobile === 'no' ? ['テーブル席', ''] : ['モバイルオーダー要確認', '']];
    return `<article class="card next">
      <div class="next__head"><div class="next__thumb">${isShow ? showImg(s) : foodImg(rest)}</div>
        <div style="min-width:0"><div class="kicker">${isShow ? 'Show' : 'Meal'} · ${clock(x.start)}</div>
          <h1 class="next__title">${jw(isShow ? x.title : `${x.title}：${x.place}`)}</h1>${rest ? `<div class="next__en">${esc(rest.en)}</div>` : ''}</div></div>
      <div class="stats">
        ${stat(isShow ? '開演' : '開始', 'clock', clock(x.start))}
        ${stat('徒歩', 'walk', `${p.walk}<small>分</small>`)}
        ${isShow ? stat('場所取り', 'flag', clock(x.start - x.claim)) : stat('所要', 'flag', `${x.end - x.start}<small>分</small>`)}
      </div>
      <div class="tags">${tags.map(([t, k]) => `<span class="tag ${k ? 'tag--' + k : ''}">${esc(t)}</span>`).join('')}</div>
      <div class="btnrow">
        <a class="btn" href="${routeUrl(x.pos)}" target="_blank" rel="noopener">${ic('route')}ルート</a>
        ${rest ? `<button class="btn" data-open-food="${rest.id}">${ic('food')}メニュー</button>` : `<button class="btn" data-open-show="${x.show}">${ic('info')}くわしく</button>`}
      </div></article>`;
  }

  const nearSnacks = RESTAURANTS.filter((x) => x.kind === 'sweets' || x.kind === 'snack')
    .map((x) => ({ x, w: walkMin(c.pos, coordsOf(x.id)) })).sort((a, b) => a.w - b.w).slice(0, 4);
  return `<article class="card next">
    <div><div class="kicker">Free time</div><h1 class="next__title">${next ? `${esc(next.title)}まで ${fmtDur(p.minutes)}` : '自由時間'}</h1>
      <div class="next__en">おやつ・写真・お土産に</div></div>
    ${next ? `<div class="tags"><span class="tag tag--warn">${clock(r.leaveBy)} に移動開始</span></div>` : ''}
    <div class="restgrid">${nearSnacks.map((n) => `<button class="rest" data-open-food="${n.x.id}"><span class="rest__n">${jw(n.x.ja)}</span><span class="rest__s">徒歩${n.w}分</span></button>`).join('')}</div>
  </article>`;
}

function renderLocRow(pos) {
  const t = pos.src === 'gps' ? 'GPS' : pos.src === 'outside' ? 'パークの外' : pos.src === 'none' ? '未設定' : '推定';
  const sub = pos.src === 'land' ? landById[S.land]?.ja : pos.src === 'last' ? pos.label.replace(/^最後に体験した「(.+)」付近と仮定$/, '$1 付近') : pos.src === 'entrance' ? '入口' : pos.src === 'gps' && pos.weak ? '精度低め' : '';
  return `<div class="setrow locrow"><span class="setrow__ico">${ic('pin')}</span><div class="setrow__b"><div class="setrow__t">現在地 <b>${t}</b>${sub ? ` · ${esc(sub)}` : ''}</div>${R.gpsErr ? `<div class="setrow__s" style="color:var(--red)">${esc(R.gpsErr)}</div>` : ''}</div>
    <button class="btn btn--sm" data-act="pick-land">エリア</button></div>`;
}
function footer() {
  return `<p class="footer">非公式の個人用ナビ · 待ち時間 ThemeParks.wiki / Queue-Times.com</p>`;
}

// =====================================================================
// PLAN (timeline) + condition builder
// =====================================================================
function condSummary(D) {
  const must = Object.keys(D.must).filter((id) => attractionById[id]);
  const meals = PLANS[D.plan].meals.filter((m) => !D.prefs.mealOverrides[m.id]?.off).map((m) => {
    const ov = D.prefs.mealOverrides[m.id] || {};
    return `${m.id === 'lunch' ? 'ランチ' : m.id === 'dinner' ? 'ディナー' : 'おやつ'} ${restaurantById[ov.restaurant || m.restaurant]?.ja.split('・')[0]}`;
  });
  const shows = SHOWS.filter((s) => D.prefs.shows[s.id]?.on ?? PLANS[D.plan].shows[s.id]).map((s) => s.short.replace('ハロウィン・', ''));
  return [
    ['条件', `${PACE[D.plan]} · 待ち〜${D.cond.maxWait}分 · 歩く量${WALK_JA[D.cond.walk]}`],
    ['絶対', must.length ? must.map((id) => attractionById[id].short).join(' / ') : 'なし'],
    ['ごはん', meals.join(' / ') || 'なし'], ['ショー', shows.join(' / ') || 'なし'],
  ];
}
const WALK_JA = { low: '少なめ', normal: 'ふつう', any: '気にしない' };

function renderPlan() {
  const el = $('#view-plan');
  const c = ctx();
  const sim = planOf(c);
  const manual = !!S.order;
  const edit = R.planEdit;
  const done = doneRides();
  const conflicts = manual ? [] : anchorConflicts(c.anchors);
  const D = { plan: S.plan, cond: S.cond, must: mustMap(), prefs: S.prefs };
  const mustIds = Object.keys(mustMap()).filter((id) => attractionById[id]);
  let html = `<div class="card condsum">
    <dl class="kv condsum__kv">${condSummary(D).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <button class="btn btn--navy btn--block" data-act="plan-edit">${ic('sliders')}条件を変えてプランを作る</button></div>`;
  html += `<div class="kpis">
    <div class="card kpi"><b>${done.length + sim.rides}</b><span>乗り物</span></div>
    <div class="card kpi"><b>${mustIds.length - sim.missingMust.length}/${mustIds.length}</b><span>絶対乗る</span></div>
    <div class="card kpi"><b>${sim.items.filter((i) => i.type === 'meal' || i.type === 'show').length}</b><span>ごはん・ショー</span></div></div>`;
  if (sim.missingMust.length) html += `<div class="note note--bad">${ic('alert')}<div><div class="note__t">${sim.missingMust.map((id) => esc(attractionById[id].short)).join('・')} が入りきらない</div><div class="note__s">${manual ? '「追加」から入れられます' : '休止中なら再開後に最優先で案内'}</div></div></div>`;
  if (conflicts.length) html += `<div class="note note--bad">${ic('alert')}<div><div class="note__t">ごはんとショーの時間が重なっています</div></div></div>`;

  html += `<div class="sec"><h2><span class="sec__en">TIMELINE</span>これから</h2><span class="sec__btns">
    ${edit ? `<button class="btn btn--sm btn--primary" data-act="plan-edit-done">${ic('check')}完了</button>`
      : `<button class="btn btn--sm" data-act="plan-edit-order">${ic('edit')}編集</button><button class="btn btn--sm ${R.liveStatus === 'loading' ? 'is-busy' : ''}" data-act="replan" ${R.liveStatus === 'loading' ? 'disabled' : ''}>${ic('refresh')}${manual ? '更新' : '組み直す'}</button>`}</span></div>
    <div class="planmode ${manual ? 'is-manual' : ''}">${manual
      ? `${ic('edit')}<span>あなたの順番で時刻を計算中</span><button class="linkbtn" data-act="plan-auto">おまかせに戻す</button>`
      : `${ic('refresh')}<span>おまかせ：待ち時間と歩く距離で自動で並べています${edit ? '（動かすとあなたの順番に切り替わります）' : ''}</span>`}</div>
    <ol class="tl ${edit ? 'tl--edit' : ''}">`;
  const ctl = (id) => `<span class="tl__ctl"><button data-mv="${id}" data-d="-1" aria-label="上へ">${ic('up')}</button><button data-mv="${id}" data-d="1" aria-label="下へ">${ic('down')}</button><button class="tl__rm" data-rm="${id}" aria-label="削除">${ic('x')}</button></span>`;
  for (const it of sim.items) {
    if (it.type === 'free' && (it.end - it.start < 10 || edit)) continue;
    if (it.type === 'ride') {
      const a = it.a;
      const off = it.blocked || it.over;
      html += `<li class="tl__item ${it.must ? 'tl__item--must' : ''} ${off ? 'tl__item--off' : ''}"><span class="tl__time">${off ? '—' : clock(it.start)}</span>
        <div class="tl__card"><button class="tl__main" data-open="${a.id}"><span class="tl__name">${jw(a.short)}${it.must ? '<span class="tag tag--must">絶対</span>' : ''}${it.blocked ? `<span class="tag tag--bad">${esc(it.blocked)}</span>` : ''}${it.over ? '<span class="tag tag--bad">閉園に間に合わない</span>' : ''}</span>
          ${off ? '' : `<span class="tl__meta"><span>${ic('clock')}待ち${it.wait}分</span>${kindTag(it.waitKind)}<span>${ic('walk')}${it.walk}分</span><span>〜<span class="num">${clock(it.end)}</span></span></span>`}</button>
          ${edit ? ctl(a.id) : `<button class="check" data-done="${a.id}" aria-label="${esc(a.short)} 乗った">${ic('check')}</button>`}</div></li>`;
    } else if (it.type === 'meal' || it.type === 'show') {
      const x = it.anchor;
      const lateTag = x.late === 'miss' ? '<span class="tag tag--bad">間に合わない</span>' : x.late === 'short' ? '<span class="tag tag--warn">場所取り短め</span>' : '';
      html += `<li class="tl__item tl__item--${it.type}"><span class="tl__time">${clock(x.start)}</span>
        <div class="tl__card"><button class="tl__main" data-anchor-edit="${x.id}"><span class="tl__name">${jw(x.title)}${it.type === 'show' ? '<span class="tag">時刻固定</span>' : ''}${x.shifted && !manual ? '<span class="tag tag--warn">時間をずらした</span>' : ''}${lateTag}</span>
          <span class="tl__meta">${it.type === 'meal' ? `<span>${ic('food')}${esc(x.place)}</span>` : ''}<span><span class="num">${clock(x.start)}–${clock(x.end)}</span></span>${x.claim && x.late !== 'miss' ? `<span style="color:var(--red)">場所取り <span class="num">${clock(it.claimFrom ?? x.start - x.claim)}</span>〜</span>` : ''}</span></button>
          ${edit ? ctl(x.id) : `<button class="check" data-done="${x.id}" aria-label="${esc(x.title)} 完了">${ic('check')}</button>`}</div></li>`;
    } else if (it.type === 'dropped') {
      html += `<li class="tl__item tl__item--dropped"><span class="tl__time">${clock(it.start)}</span>
        <div class="tl__card"><div class="tl__main"><span class="tl__name" style="text-decoration:line-through">${esc(it.anchor.title)}</span><span class="tl__meta">絶対乗るものを優先して見送り</span></div></div></li>`;
    } else {
      html += `<li class="tl__item tl__item--free"><span class="tl__time">${clock(it.start)}</span><div class="tl__card">自由時間 ${fmtDur(it.end - it.start)}</div></li>`;
    }
  }
  html += `</ol><button class="btn btn--block addbtn" data-act="plan-add">${ic('plus')}乗り物・ごはん・ショーを追加</button>`;

  const doneIds = Object.keys(S.done).sort((a, b) => (S.doneMin[a] ?? 0) - (S.doneMin[b] ?? 0) || S.done[a] - S.done[b]);
  if (doneIds.length) {
    html += `<div class="sec"><h2><span class="sec__en">DONE</span>済み</h2><span class="sec__sub">${doneIds.length}件</span></div><ol class="tl tl--done">`;
    for (const id of doneIds) {
      html += `<li class="tl__item tl__item--done"><span class="tl__time">${S.doneMin[id] != null ? clock(S.doneMin[id]) : '—'}</span>
        <div class="tl__card"><div class="tl__main"><span class="tl__name">${jw(doneName(id))}</span></div><button class="check is-done" data-done="${id}" aria-label="完了済み（タップで戻す）">${ic('check')}</button></div></li>`;
    }
    html += `</ol>`;
  }
  el.innerHTML = html;
  R.lastPlanIds = sim.items.map((i) => i.id).join(',');
}

// ---------- add sheet: any ride / meal / show, placed where the route flows best (or as the very next stop) ----------
function openAddSheet() {
  const c = ctx();
  const inPlan = new Set(S.order || orderFromPlan(simulateDay(c)));
  const rides = ATTRACTIONS.filter((a) => !S.done[a.id] && !inPlan.has(a.id))
    .sort((a, b) => b.pop - a.pop || (PRIORITY[b.id] || 0) - (PRIORITY[a.id] || 0));
  const meals = PLANS[S.plan].meals.filter((m) => !inPlan.has('meal:' + m.id) && !S.done['meal:' + m.id]);
  const shows = SHOWS.filter((x) => !inPlan.has('show:' + x.id) && !S.done['show:' + x.id]);
  const best = R.addMode !== 'next';
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Add</div><h2 class="sheet__title" id="sheetTitle">プランに追加</h2></div>
    <div class="seg"><button class="${best ? 'is-active' : ''}" data-add-mode="best">動線のいい位置に</button><button class="${best ? '' : 'is-active'}" data-add-mode="next">次に行く</button></div>
    ${meals.length || shows.length ? `<div class="card rows">${meals.map((m) => {
      const mc = mealCfg(m.id);
      return `<button class="row" type="button" data-add="meal:${m.id}"><span class="row__body"><span class="row__k">ごはん</span><span class="row__name">${esc(m.ja)}</span><span class="row__meta">${ic('food')}${esc(restaurantById[mc.rest]?.ja || '')} · ${mc.dur}分</span></span><span class="row__chev">${ic('plus')}</span></button>`;
    }).join('')}${shows.map((x) => `<button class="row" type="button" data-add="show:${x.id}"><span class="row__body"><span class="row__k">ショー</span><span class="row__name">${jw(x.short)}</span><span class="row__meta">${ic('clock')}${showTimesFor(x.id).times.join(' / ')}</span></span><span class="row__chev">${ic('plus')}</span></button>`).join('')}</div>` : ''}
    <div class="card rows">${rides.map((a) => {
      const w = waitInfo(a);
      return `<button class="row" type="button" data-add="${a.id}"><span class="row__thumb">${rideImg(a)}</span>
        <span class="row__body"><span class="row__k">${esc(landById[a.land]?.ja || '')}</span><span class="row__name">${jw(a.short)}</span><span class="row__meta">${ic('walk')}${walkMin(c.pos, coordsOf(a.id))}分</span></span>
        <span class="row__wait">${w.wait == null ? `<span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止')}</span>` : `<b class="${waitClass(w.wait)}">${w.wait}</b><small>分</small>`}</span></button>`;
    }).join('') || '<div class="empty">追加できる乗り物はありません</div>'}</div>
  </div>`, { keepScroll: true });
}

// ---------- condition builder (one screen; edits a draft, applied with one button) ----------
const MEAL_JA = { lunch: 'ランチ', snack: 'おやつ', dinner: 'ディナー' };
const MEAL_RANGE = { lunch: [10 * 60 + 30, 14 * 60], snack: [13 * 60, 17 * 60 + 30], dinner: [16 * 60 + 30, 20 * 60 + 30] };
function draftCtx(D) {
  const showTimes = {};
  for (const s of SHOWS) showTimes[s.id] = showTimesFor(s.id).times;
  const anchorsD = buildAnchors(D.plan, { ...D.prefs, showTimes }, S.done);
  return ctx({ planId: D.plan, cond: D.cond, must: D.must, excluded: D.excluded, anchors: anchorsD, pin: D.first ? { id: D.first, until: hours().close } : S.pin });
}
function openPlanBuilder(focus) {
  if (!R.draft) R.draft = structuredClone({ plan: S.plan, cond: S.cond, must: mustMap(), excluded: S.excluded, prefs: { ...S.prefs, showTimes: undefined }, first: '' });
  const D = R.draft;
  const sim = simulateDay(draftCtx(D));
  const mustIds = Object.keys(D.must);
  const opt = (key, val, label, sub) => `<button class="opt ${String(key === 'plan' ? D.plan : D.cond[key]) === String(val) ? 'is-active' : ''}" data-b-set="${key}" data-v="${val}"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
  const rides = [...ATTRACTIONS].sort((a, b) => b.pop - a.pop || (PRIORITY[b.id] || 0) - (PRIORITY[a.id] || 0));
  const showOn = (id) => D.prefs.shows[id]?.on ?? PLANS[D.plan].shows[id];
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Plan builder</div><h2 class="sheet__title" id="sheetTitle">プランの条件</h2></div>
    <div class="form">
      <div class="field"><div class="field__h"><b>ペース</b><span>1日に乗る数</span></div>
        <div class="opts">${opt('plan', 'relax', 'ゆったり', '6前後')}${opt('plan', 'balance', 'ふつう', '9前後')}${opt('plan', 'rides', 'たくさん', '12以上')}</div></div>
      <div class="field"><div class="field__h"><b>混雑</b><span>並んでもいい時間</span></div>
        <div class="opts">${opt('maxWait', 30, '〜30分', '空いてる所')}${opt('maxWait', 60, '〜60分', 'ふつう')}${opt('maxWait', 90, '〜90分', '人気優先')}</div></div>
      <div class="field"><div class="field__h"><b>動線</b><span>歩く量</span></div>
        <div class="opts">${opt('walk', 'low', '少なめ', '近くを順に')}${opt('walk', 'normal', 'ふつう', '')}${opt('walk', 'any', '気にしない', '遠くてもOK')}</div></div>
      <div class="field" id="b-first"><div class="field__h"><b>次に行きたいところ</b><span>あれば</span></div>
        <select data-b-first aria-label="次に行きたいところ"><option value="">おまかせ</option>${rides.filter((a) => !S.done[a.id]).map((a) => `<option value="${a.id}" ${D.first === a.id ? 'selected' : ''}>${esc(a.short)}</option>`).join('')}</select></div>
      <div class="field" id="b-rides"><div class="field__h"><b>乗りたいもの</b><span>タップで切替</span></div>
        <div class="legend"><span><i class="m"></i>絶対乗る</span><span><i></i>おまかせ</span><span><i class="s"></i>乗らない</span></div>
        <div class="ridepick">${rides.map((a) => {
          const st = D.must[a.id] ? 'must' : D.excluded[a.id] ? 'skip' : '';
          return `<button class="rp ${st ? 'is-' + st : ''}" data-b-ride="${a.id}" aria-label="${esc(a.short)}：${st === 'must' ? '絶対乗る' : st === 'skip' ? '乗らない' : 'おまかせ'}"><span class="rp__st">${st === 'must' ? ic('check') : ''}</span><span>${jw(a.short)}</span></button>`;
        }).join('')}</div></div>
      <div class="field" id="b-meals"><div class="field__h"><b>ごはん</b><span>お店と時間</span></div>
        ${PLANS[D.plan].meals.map((m) => {
          const ov = D.prefs.mealOverrides[m.id] || {};
          const at = ov.at ?? m.at, rest = ov.restaurant || m.restaurant, on = !ov.off, dur = ov.dur ?? m.dur;
          const durs = [...new Set([20, 30, 45, 60, 75, 90, 120, dur])].sort((x, y) => x - y);
          const [t0, t1] = MEAL_RANGE[m.id];
          const times = []; for (let t = t0; t <= t1; t += 15) times.push(t);
          if (!times.includes(at)) times.push(at), times.sort((x, y) => x - y);
          const opts = RESTAURANTS.filter((r) => (m.id === 'snack' ? r.kind !== 'meal' || r.id === rest : r.kind === 'meal' || r.kind === 'cafe'));
          return `<div class="mealrow"><div class="mealrow__h"><b>${MEAL_JA[m.id]}</b><span class="toggle"><input type="checkbox" data-b-meal-on="${m.id}" ${on ? 'checked' : ''} aria-label="${MEAL_JA[m.id]}"><i></i></span></div>
            ${on ? `<div class="mealrow__ctl">
              <select data-b-meal-rest="${m.id}" aria-label="${MEAL_JA[m.id]}のお店">${opts.map((r) => `<option value="${r.id}" ${r.id === rest ? 'selected' : ''}>${esc(r.ja)}</option>`).join('')}</select>
              <select data-b-meal-at="${m.id}" aria-label="${MEAL_JA[m.id]}の時間" class="num">${times.map((t) => `<option value="${t}" ${t === at ? 'selected' : ''}>${clock(t)}</option>`).join('')}</select>
              <select data-b-meal-dur="${m.id}" aria-label="${MEAL_JA[m.id]}にかける時間" class="num">${durs.map((t) => `<option value="${t}" ${t === dur ? 'selected' : ''}>${t}分</option>`).join('')}</select>
            </div>` : ''}</div>`;
        }).join('')}</div>
      <div class="field" id="b-shows"><div class="field__h"><b>見たいショー</b><span>回を選ぶ</span></div>
        ${SHOWS.map((s) => {
          const st = showTimesFor(s.id);
          const pick = D.prefs.shows[s.id]?.pick && st.times.includes(D.prefs.shows[s.id].pick) ? D.prefs.shows[s.id].pick : (st.times.includes(s.defaultPick) ? s.defaultPick : st.times[0]);
          return `<div class="showrow"><div class="showrow__h"><b>${jw(s.short)}</b>${st.src === 'pre' ? '<span class="tag tag--warn">時刻要確認</span>' : ''}<span class="toggle"><input type="checkbox" data-b-show-on="${s.id}" ${showOn(s.id) ? 'checked' : ''} aria-label="${esc(s.short)}"><i></i></span></div>
            ${showOn(s.id) ? `<div class="times">${st.times.map((t) => `<button class="time ${t === pick ? 'is-active' : ''}" data-b-show-pick="${s.id}" data-time="${t}">${t}</button>`).join('')}</div>` : ''}</div>`;
        }).join('')}</div>
    </div></div>
    <div class="sheet__foot">${S.order ? '<p class="sheet__hint">自分で並べた順番は、おまかせで作り直されます</p>' : ''}<button class="btn btn--primary btn--block" data-act="plan-apply">この条件でプランを作る<span class="num" style="font-weight:500;margin-left:6px">乗り物 ${doneRides().length + sim.rides} · 絶対 ${mustIds.length - sim.missingMust.length}/${mustIds.length}</span></button></div>`,
  { keepScroll: true });
  if (focus) { const f = $('#b-' + focus); if (f) $('.sheet__panel').scrollTop = f.offsetTop - 30; }
}
function applyPlanDraft() {
  const D = R.draft;
  if (!D) return;
  S.plan = D.plan; S.cond = D.cond; S.must = D.must; S.excluded = D.excluded;
  S.prefs = { ...S.prefs, mealOverrides: D.prefs.mealOverrides, shows: D.prefs.shows };
  for (const id of Object.keys(S.must)) delete S.excluded[id];
  S.order = null; // conditions → fresh おまかせ plan, which can then be edited
  if (D.first) { S.pin = { id: D.first, until: hours().close }; delete S.excluded[D.first]; }
  save(); closeSheet(); go('plan');
  toast(`プランを作りました（乗り物 ${doneRides().length + simulateDay(ctx()).rides}）`, 'ok');
}

// =====================================================================
// EXPLORE (rides / food / shows / halloween)
// =====================================================================
function renderExplore() {
  const el = $('#view-explore');
  const tab = S.exploreTab;
  let html = `<div class="seg" role="tablist">${[['rides', '乗り物'], ['food', '食事'], ['shows', 'ショー'], ['halloween', '限定']].map(([k, n]) => `<button class="${tab === k ? 'is-active' : ''}" data-xtab="${k}" role="tab" aria-selected="${tab === k}">${n}</button>`).join('')}</div>`;
  const c = ctx();
  if (tab === 'rides') {
    const filters = [['all', 'すべて'], ['todo', '未体験'], ['short', '30分以下'], ['japan', '日本にない'], ['done', '体験済み'], ['down', '休止中']];
    html += `<div class="chips">${filters.map(([k, n]) => `<button class="chip ${S.exploreFilter === k ? 'is-active' : ''}" data-xf="${k}">${n}</button>`).join('')}</div>`;
    html += `<div class="sortrow"><span id="xcount"></span><select data-xsort aria-label="並べ替え">${[['reco', 'おすすめ順'], ['wait', '待ち時間順'], ['dist', '近い順'], ['pop', '人気順'], ['thrill', 'スリル順']].map(([k, n]) => `<option value="${k}" ${S.exploreSort === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    let list = ATTRACTIONS.map((a) => ({ a, w: waitInfo(a), walk: walkMin(c.pos, coordsOf(a.id)), d: c.pos ? distanceM(c.pos, coordsOf(a.id)) : null }));
    const f = S.exploreFilter;
    list = list.filter(({ a, w }) => f === 'all'
      || (f === 'short' && w.wait != null && w.wait <= 30)
      || (f === 'todo' && !S.done[a.id]) || (f === 'done' && S.done[a.id])
      || (f === 'down' && w.status && w.status !== 'OPERATING' && c.now >= c.openMin)
      || (f === 'japan' && /日本未上陸|日本にない/.test(a.japan)));
    const sort = S.exploreSort;
    const reco = recommend(c);
    const rank = new Map([reco.primary?.a?.id, ...reco.alts.map((x) => x.a.id)].filter(Boolean).map((id, i) => [id, i]));
    const must = mustMap();
    list.sort((x, y) => {
      if (sort === 'wait') return (x.w.wait ?? 999) - (y.w.wait ?? 999);
      if (sort === 'dist') return (x.d ?? 1e9) - (y.d ?? 1e9);
      if (sort === 'pop') return y.a.pop - x.a.pop || (PRIORITY[y.a.id] || 0) - (PRIORITY[x.a.id] || 0);
      if (sort === 'thrill') return y.a.thrill - x.a.thrill;
      return (rank.get(x.a.id) ?? 99) - (rank.get(y.a.id) ?? 99) || (!!must[y.a.id] - !!must[x.a.id]) || (PRIORITY[y.a.id] || 0) - (PRIORITY[x.a.id] || 0);
    });
    html += `<div class="card rows">${list.map(({ a, w, walk }) => `
      <button class="row ${S.done[a.id] ? 'is-done' : ''}" data-open="${a.id}" type="button">
        <span class="row__thumb">${rideImg(a)}</span>
        <span class="row__body"><span class="row__name">${jw(a.short)}</span>
          <span class="row__meta"><span>${esc(landById[a.land]?.ja)}</span><span>${ic('walk')}${walk}分</span>${sparkSmall(a.id)}</span>
          <span class="tags" style="margin-top:3px">${must[a.id] ? '<span class="tag tag--must">絶対</span>' : ''}${S.done[a.id] ? '<span class="tag">済み</span>' : ''}${rank.has(a.id) && !S.done[a.id] ? '<span class="tag tag--warn">今おすすめ</span>' : ''}${/日本未上陸/.test(a.japan) ? '<span class="tag">日本にない</span>' : ''}</span></span>
        <span class="row__wait">${w.wait == null ? `<span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止')}</span>` : `<b class="${waitClass(w.wait)}">${w.wait}</b><small>分</small><br>${kindTag(w.kind)}`}</span>
      </button>`).join('') || '<div class="empty">該当なし</div>'}</div>`;
    el.innerHTML = html;
    $('#xcount').textContent = `${list.length}件`;
    return;
  }
  if (tab === 'food') {
    const filters = [['all', 'すべて'], ['meal', '食事'], ['sweets', 'スイーツ'], ['snack', '軽食'], ['mobile', 'モバイルオーダー'], ['halloween', '限定あり']];
    html += `<div class="chips">${filters.map(([k, n]) => `<button class="chip ${S.foodFilter === k ? 'is-active' : ''}" data-ff="${k}">${n}</button>`).join('')}</div>`;
    let list = RESTAURANTS.map((r) => ({ r, walk: walkMin(c.pos, coordsOf(r.id)), d: c.pos ? distanceM(c.pos, coordsOf(r.id)) : 0 }));
    const f = S.foodFilter;
    list = list.filter(({ r }) => f === 'all' || (f === 'meal' && (r.kind === 'meal' || r.kind === 'cafe')) || (f === 'sweets' && (r.kind === 'sweets' || r.kind === 'cafe')) || (f === 'snack' && r.kind === 'snack') || (f === 'mobile' && r.mobile === 'yes') || (f === 'halloween' && r.halloween.length));
    list.sort((x, y) => (x.d ?? 0) - (y.d ?? 0));
    html += `<div class="card rows">${list.map(({ r, walk }) => `
      <button class="row" data-open-food="${r.id}" type="button">
        <span class="row__thumb">${foodImg(r)}</span>
        <span class="row__body"><span class="row__name">${jw(r.ja)}</span>
          <span class="row__meta"><span>${esc(r.menu[0]?.name || '')}</span></span>
          <span class="row__meta"><span>${ic('walk')}${walk}分</span>${r.mobile === 'yes' ? '<span class="tag tag--live">モバイルオーダー</span>' : ''}${r.halloween.length ? '<span class="tag tag--warn">限定</span>' : ''}</span></span>
        <span class="row__chev">${ic('chev')}</span></button>`).join('')}</div>
      <p class="footer">料金・限定メニューは事前調査の情報です</p>`;
    el.innerHTML = html;
    return;
  }
  if (tab === 'shows') {
    const an = c.anchors.filter((a) => a.kind === 'show' && !a.done && a.end > c.now);
    if (an[0]) {
      const x = an[0];
      html += `<div class="countdown"><div><div class="countdown__k">NEXT SHOW</div><div class="countdown__n">${jw(x.title)} <span class="num">${clock(x.start)}</span></div>
        <div style="font-size:12.5px;color:var(--mustard)">場所取り <span class="num">${clock(x.start - x.claim)}</span>〜</div></div>
        <div class="countdown__v">${fmtDur(x.start - c.now)}<small>開演まで</small></div></div>`;
    }
    const fw = c.anchors.find((a) => a.show === 'fireworks'), fm = c.anchors.find((a) => a.show === 'fantasmic');
    if (fw && fm) {
      const steps = fw.start < fm.start
        ? [[clock(fw.start - fw.claim), '川沿いへ'], [clock(fw.start), '花火'], [clock(fw.end), 'その場で待つ'], [clock(fm.start), 'ファンタズ<wbr>ミック']]
        : [[clock(fm.start - fm.claim), '川沿いへ'], [clock(fm.start), 'ファンタズミック'], [clock(fm.end), 'そのまま'], [clock(fw.start), '花火']];
      html += `<div class="card card--pad"><div class="sec" style="margin:0 0 10px"><h2><span class="sec__en">NIGHT</span>夜の動き方</h2><span class="sec__sub">移動ほぼなし</span></div>
        <div class="flow">${steps.map(([t, s]) => `<div class="flow__step"><div class="flow__t">${t}</div><div class="flow__s">${s}</div></div>`).join('')}</div></div>`;
    }
    html += `<div class="card rows">${SHOWS.map((s) => {
      const st = showTimesFor(s.id);
      const pick = c.anchors.find((a) => a.show === s.id);
      return `<button class="row" data-open-show="${s.id}" type="button"><span class="row__thumb">${showImg(s)}</span>
        <span class="row__body"><span class="row__name">${jw(s.short)}</span>
          <span class="row__meta"><span class="num">${st.times.join(' / ')}</span>${st.src === 'pre' ? '<span class="tag tag--warn">要確認</span>' : st.src === 'api' ? '<span class="tag tag--live">公式</span>' : '<span class="tag tag--manual">手入力</span>'}</span></span>
        <span class="row__wait">${pick ? `<span class="tag tag--must">予定 ${hhmm(pick.start)}</span>` : '<span class="tag">予定なし</span>'}</span></button>`;
    }).join('')}</div>
    <button class="btn btn--block" data-act="plan-edit-shows">${ic('sliders')}見るショーと回を変える</button>`;
    const others = R.live?.otherShows || [];
    if (others.length) {
      html += `<div class="sec"><h2>その他のショー</h2></div><div class="card card--pad" style="font-size:13.5px;line-height:1.9">${others.slice(0, 12).map((o) => `<div><b>${esc(o.name)}</b> <span class="num">${o.times.filter((t) => !t.date || t.date === TRIP.date).map((t) => hhmm(t.start)).join(' / ') || '—'}</span></div>`).join('')}</div>`;
    }
    el.innerHTML = html;
    return;
  }
  // halloween
  html += `<div class="note">${ic('info')}<div><div class="note__t">今日でハロウィン最終日</div><div class="note__s">「〜10/31」の限定品は今日が最後かも。在庫は未確認</div></div></div>`;
  html += `<div class="sec"><h2><span class="sec__en">POPCORN</span>ポップコーンバケット</h2></div><div class="card rows">${POPCORN.map((p) => `
    <div class="row"><span class="row__body"><span class="row__name">${jw(p.ja)}</span>
      <span class="row__meta"><span class="num">${esc(p.price)}</span></span>
      <span class="row__meta">${esc(p.where)}</span></span></div>`).join('')}</div>`;
  html += `<div class="sec"><h2><span class="sec__en">FOOD</span>限定フード</h2></div><div class="card rows">`;
  html += RESTAURANTS.filter((r) => r.halloween.length).flatMap((r) => r.halloween.map((h) => ({ r, h }))).map(({ r, h }) => `
    <button class="row" data-open-food="${r.id}"><span class="row__body"><span class="row__name">${esc(h.name)}</span><span class="row__meta">${esc(r.ja)}</span></span><span class="row__chev">${ic('chev')}</span></button>`).join('');
  html += `</div><p class="footer">出典：Disney Parks Blog ほか各種報道（2026年8〜10月）</p>`;
  el.innerHTML = html;
}

// =====================================================================
// SHEETS
// =====================================================================
function openAttraction(id) {
  const a = attractionById[id];
  const c = ctx();
  const w = waitInfo(a);
  const av = availability(a, c);
  const pos = coordsOf(a.id);
  const walk = walkMin(c.pos, pos);
  const raw = R.live?.attractions?.[a.id];
  const must = !!mustMap()[a.id];
  const manualOn = S.manual[a.id] && Date.now() - S.manual[a.id].at < 30 * 60e3;
  openSheet(`
    <div class="sheet__hero">${rideImg(a)}${R.photos[a.id] ? `<a class="credit" href="${esc(R.photos[a.id].page)}" target="_blank" rel="noopener">${esc(credit(a.id))}</a>` : ''}</div>
    <div class="sheet__content">
      <div><div class="kicker">${esc(landById[a.land]?.en)}</div><h2 class="sheet__title" id="sheetTitle">${jw(a.ja)}</h2><div class="next__en">${esc(a.en)}</div></div>
      <div class="stats">
        ${stat('待ち', 'clock', w.wait == null ? '—' : `<span class="${waitClass(w.wait)}">${w.wait}</span><small>分</small>`, w.wait == null ? `<span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止')}</span>` : kindTag(w.kind))}
        ${stat('徒歩', 'walk', `${walk}<small>分</small>`)}
        ${stat('スリル', 'star', `<span style="font-size:13px">${dots(a.thrill)}</span>`)}
      </div>
      ${!av.ok ? `<div class="note note--bad">${ic('alert')}<div><div class="note__t">${esc(av.reason)}</div>${must ? '<div class="note__s">再開したら最優先で案内します</div>' : ''}</div></div>` : ''}
      <div class="btnrow">
        ${S.done[a.id] ? `<button class="btn" data-done="${a.id}">${ic('check')}済み ${S.doneMin[a.id] != null ? clock(S.doneMin[a.id]) : ''}</button>` : `<button class="btn btn--primary" data-done="${a.id}" data-close>${ic('check')}乗った</button>`}
        <a class="btn" href="${routeUrl(pos)}" target="_blank" rel="noopener">${ic('route')}ルート</a>
      </div>
      ${S.done[a.id] ? '' : `<div class="btnrow">${(S.order || orderFromPlan(simulateDay(c))).includes(a.id) ? `<span class="muted" style="flex:1;align-self:center;font-size:13px">${ic('check')} プランに入っています</span>` : `<button class="btn" data-add="${a.id}" data-add-how="best" data-close>${ic('plus')}プランに追加</button>`}<button class="btn" data-add="${a.id}" data-add-how="next" data-close>${ic('flag')}次に行く</button></div>`}
      <div class="seg"><button class="${must ? 'is-active' : ''}" data-ride-st="${a.id}" data-v="must">絶対乗る</button><button class="${!must && !S.excluded[a.id] ? 'is-active' : ''}" data-ride-st="${a.id}" data-v="">おまかせ</button><button class="${S.excluded[a.id] ? 'is-active' : ''}" data-ride-st="${a.id}" data-v="skip">乗らない</button></div>
      <p class="para">${esc(a.desc)}</p>
      <div class="box"><b>日本との違い</b>${esc(a.japan)}</div>
      <div class="box"><b>コツ</b>${esc(a.tip)}</div>
      ${sparkBig(a)}
      <details class="more"><summary>公式アプリの待ち時間を入力</summary>
        <div class="formrow" style="margin-top:8px"><input type="number" inputmode="numeric" min="0" max="300" step="5" id="manualWait" placeholder="分" style="width:90px" value="${manualOn ? S.manual[a.id].wait : ''}"><button class="btn btn--navy btn--sm" data-manual-save="${a.id}">保存</button>${S.manual[a.id] ? `<button class="btn btn--sm" data-manual-clear="${a.id}">消去</button>` : ''}</div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">30分間この値で案内します</p></details>
      <details class="more"><summary>データの詳細</summary>
        <dl class="kv" style="margin-top:6px">
          <dt>取得元</dt><dd>${raw ? `${esc(R.live.sourceLabel)}：${esc(STATUS_JA[raw.status] || raw.status)}${raw.wait != null ? ` / ${raw.wait}分` : ''}` : '外部データなし（推定）'}</dd>
          ${raw?.single != null ? `<dt>シングル</dt><dd>${raw.single}分</dd>` : ''}
          <dt>所要</dt><dd>約${a.dur}分</dd>
          <dt>位置</dt><dd>${pos.src === 'api' ? 'ThemeParks.wiki' : '概略位置'}</dd>
        </dl></details>
    </div>`);
}

function openFood(id) {
  const r = restaurantById[id];
  const c = ctx();
  const pos = coordsOf(r.id);
  const walk = walkMin(c.pos, pos);
  openSheet(`
    <div class="sheet__hero">${foodImg(r)}${R.photos['food_' + r.id] ? `<a class="credit" href="${esc(R.photos['food_' + r.id].page)}" target="_blank" rel="noopener">${esc(credit('food_' + r.id))}</a>` : ''}</div>
    <div class="sheet__content">
      <div><div class="kicker">${esc(landById[r.land]?.en)} · ${esc(r.style)}</div><h2 class="sheet__title" id="sheetTitle">${jw(r.ja)}</h2><div class="next__en">${esc(r.en)}</div></div>
      <div class="tags"><span class="tag">${ic('walk')}徒歩${walk}分</span>${r.mobile === 'yes' ? '<span class="tag tag--live">モバイルオーダー可</span>' : r.mobile === 'no' ? '<span class="tag">テーブル席</span>' : '<span class="tag">モバイルオーダー要確認</span>'}<span class="tag">${esc(r.hours)}</span></div>
      <p class="para">${esc(r.desc)}</p>
      <ul class="menu">${r.menu.map((m) => `<li><span>${esc(m.name)}<br><small class="muted">${esc(m.en)}</small></span><span>${esc(m.price)}</span></li>`).join('')}</ul>
      ${r.halloween.length ? `<div class="box"><b>ハロウィン限定（報道ベース）</b>${r.halloween.map((h) => `${esc(h.name)}<span class="muted">（${esc(h.note)}）</span>`).join('<br>')}</div>` : ''}
      <div class="btnrow">
        <a class="btn" href="${routeUrl(pos)}" target="_blank" rel="noopener">${ic('route')}ルート</a>
        <a class="btn btn--navy" href="${esc(r.menuUrl)}" target="_blank" rel="noopener">公式メニュー</a>
      </div>
    </div>`);
}

function openShow(id) {
  const s = showById[id];
  const c = ctx();
  const st = showTimesFor(s.id);
  const pick = c.anchors.find((a) => a.show === s.id);
  const apiStatus = R.live?.shows?.[s.id]?.status;
  openSheet(`
    <div class="sheet__hero">${showImg(s)}</div>
    <div class="sheet__content">
      <div><div class="kicker">Show</div><h2 class="sheet__title" id="sheetTitle">${jw(s.ja)}</h2><div class="next__en">${esc(s.en)}</div></div>
      <div><div class="field__h"><b>回を選ぶ</b>${st.src === 'pre' ? '<span class="tag tag--warn">時刻は要確認</span>' : st.src === 'api' ? '<span class="tag tag--live">公式</span>' : '<span class="tag tag--manual">手入力</span>'}${apiStatus && apiStatus !== 'OPERATING' ? `<span class="tag tag--bad">${esc(STATUS_JA[apiStatus] || apiStatus)}</span>` : ''}</div>
        <div class="times">${st.times.map((t) => `<button class="time ${pick && hhmm(pick.start) === t ? 'is-active' : ''} ${parseHHMM(t) + s.dur < c.now ? 'is-past' : ''}" data-pick-show="${s.id}" data-time="${t}">${t}</button>`).join('')}
          ${pick ? `<button class="time" data-show-off="${s.id}" style="font-family:var(--jp);font-size:13px">見ない</button>` : ''}</div></div>
      ${pick ? `<div class="tags"><span class="tag tag--warn">場所取り ${clock(pick.start - pick.claim)}〜（${pick.claim}分前）</span></div>` : ''}
      <div class="box"><b>場所</b>${esc(s.venue)}</div>
      <p class="para">${esc(s.desc)}</p>
      <div class="box"><b>見る場所のコツ</b>${esc(s.viewing)}</div>
      <details class="more"><summary>時刻を手で直す</summary>
        <div class="formrow" style="margin-top:8px"><input type="text" id="showTimesIn" value="${esc(S.prefs.showTimes[s.id]?.join(', ') || '')}" placeholder="${esc(st.times.join(', '))}" style="flex:1"><button class="btn btn--navy btn--sm" data-save-times="${s.id}">保存</button></div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">例：21:00, 22:30（空にすると自動に戻る）</p></details>
    </div>`);
}

function mealCfg(mealId) {
  const base = PLANS[S.plan].meals.find((m) => m.id === mealId);
  const ov = S.prefs.mealOverrides[mealId] || {};
  return { base, ov, at: ov.at ?? base.at, rest: ov.restaurant || base.restaurant, dur: ov.dur ?? base.dur };
}
function openAnchorEdit(id) {
  if (id.startsWith('show:')) return openShow(id.slice(5));
  const mealId = id.slice(5);
  const { base, ov, at, rest, dur } = mealCfg(mealId);
  const opts = RESTAURANTS.filter((r) => (mealId === 'snack' ? true : r.kind === 'meal' || r.kind === 'cafe'));
  const c = ctx();
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Meal</div><h2 class="sheet__title" id="sheetTitle">${esc(base.ja)}</h2></div>
    <div class="stepper">
      <button data-meal-step="${mealId}" data-delta="-15">−15分</button>
      <div class="stepper__v">${clock(at)}<div style="font-family:var(--jp);font-size:12px;font-weight:700;color:var(--muted)">${S.order ? '順番で決まる' : '開始'}</div></div>
      <button data-meal-step="${mealId}" data-delta="15">＋15分</button>
    </div>
    <div class="field__h" style="margin:0"><b>食事にかける時間</b><span class="num">${dur}分</span></div>
    <div class="times">${[20, 30, 45, 60, 75, 90, 120].map((t) => `<button class="time ${t === dur ? 'is-active' : ''}" data-meal-dur="${mealId}" data-v="${t}">${t}分</button>`).join('')}</div>
    <div class="restgrid">${opts.map((r) => `<button class="rest ${r.id === rest ? 'is-active' : ''}" data-meal-rest="${mealId}" data-rest="${r.id}">
      <span class="rest__n">${jw(r.ja)}</span><span class="rest__s">徒歩${walkMin(c.pos, coordsOf(r.id))}分${r.mobile === 'yes' ? ' · MO' : ''}</span></button>`).join('')}</div>
    <div class="btnrow"><button class="btn" data-meal-off="${mealId}">${ov.off ? '予定に戻す' : '今日は省略'}</button><button class="btn" data-meal-reset="${mealId}">初期設定</button></div>
    <button class="btn btn--navy" data-close>完了</button>
  </div>`, { keepScroll: true });
}

function openLandPicker() {
  const pos = position();
  const on = S.gps && R.gpsPos;
  openSheet(`<div class="sheet__content">
    <h2 class="sheet__title" id="sheetTitle">今どのあたり？</h2>
    ${on ? `<button class="btn" data-act="gps-stop" data-close>${ic('locate')}GPSを止める</button>` : `<button class="btn btn--navy" data-act="gps-start" data-close>${ic('locate')}GPSで現在地を使う</button>`}
    <div class="field__h" style="margin:0"><b>またはエリアを選ぶ</b><span>90分有効</span></div>
    <div class="landgrid">${LANDS.map((l) => `<button style="--c:${l.color}" class="${S.land === l.id && pos.src === 'land' ? 'is-active' : ''}" data-land="${l.id}" data-close>${esc(l.ja)}</button>`).join('')}</div>
  </div>`);
}

function openSettings() {
  const h = hours();
  const l = R.live;
  const liveTxt = R.liveStatus === 'loading' ? '更新中' : l?.ok ? `${Math.round(liveAgeMin())}分前 · ${esc(l.sourceLabel)}` : R.liveStatus === 'error' ? '取得失敗（推定で案内）' : '未取得';
  openSheet(`<div class="sheet__content">
    <h2 class="sheet__title" id="sheetTitle">設定</h2>
    <div>
      <div class="setrow"><span class="setrow__ico">${ic('locate')}</span><div class="setrow__b"><div class="setrow__t">現在地（GPS）</div><div class="setrow__s">${S.gps && R.gpsPos ? `使用中 · 精度 約${Math.round(R.gpsPos.acc)}m` : 'オフ'}</div></div>
        <span class="toggle"><input type="checkbox" data-gps-toggle ${S.gps ? 'checked' : ''} aria-label="現在地を使う"><i></i></span></div>
      ${renderLocRow(position())}
      <div class="setrow"><span class="setrow__ico">${ic('refresh')}</span><div class="setrow__b"><div class="setrow__t">待ち時間</div><div class="setrow__s">${liveTxt}</div></div>
        <button class="btn btn--sm" data-act="refresh">更新</button></div>
      <div class="setrow"><span class="setrow__ico">${ic('x')}</span><div class="setrow__b"><div class="setrow__t">記録をリセット</div><div class="setrow__s">済み・プランの条件を消去</div></div>
        <button class="btn btn--sm" data-act="reset">リセット</button></div>
    </div>
    <details class="more"><summary>詳細</summary>
      <dl class="kv" style="margin-top:8px">
        <dt>営業時間</dt><dd><span class="num">${clock(h.open)}–${clock(h.close)}</span>（${h.src === 'api' ? '公式スケジュール' : '予定値'}）</dd>
        <dt>待ち時間</dt><dd>ThemeParks.wiki → 予備 Queue-Times.com。3分ごとに自動更新、15分以上古いと推定に切替</dd>
        <dt>表示</dt><dd>${kindTag('live')} 外部提供 ${kindTag('manual')} 手入力 ${kindTag('est')} 推定</dd>
        <dt>徒歩</dt><dd>直線距離×1.4 ÷ 分速70mの目安</dd>
        <dt>位置情報</dt><dd>この端末の中だけで使用</dd>
      </dl>
      ${isStandalone() ? '' : `<div class="box" style="margin-top:10px"><b>ホーム画面に追加</b>Safariの共有ボタン → 「ホーム画面に追加」</div>`}
      <div class="box" style="margin-top:10px"><b>テスト時刻</b>
        <div class="formrow" style="margin-top:6px"><input type="time" id="simAt" value="${S.sim ? hhmm(nowMin()).padStart(5, '0') : '10:00'}"><button class="btn btn--navy btn--sm" data-act="sim-set">表示</button>${S.sim ? '<button class="btn btn--sm" data-act="sim-off">解除</button>' : ''}</div></div>
      <p style="font-size:13px;margin:10px 0 0"><a href="https://disneyland.disney.go.com/entertainment/disneyland/" target="_blank" rel="noopener">公式エンタメスケジュール</a> · <a href="https://disneyland.disney.go.com/guest-services/mobile-order/" target="_blank" rel="noopener">モバイルオーダー</a></p>
    </details>
    <p class="footer">非公式の個人用ツール · ThemeParks.wiki · Queue-Times.com · Wikipedia · © OpenStreetMap</p>
  </div>`);
}

// =====================================================================
// Router & events
// =====================================================================
let mapMod = null;
function go(tab) {
  if (tab === 'shows') { S.exploreTab = 'shows'; tab = 'explore'; }
  S.tab = tab; save();
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
  document.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('is-active', t.dataset.tab === tab); t.setAttribute('aria-current', t.dataset.tab === tab ? 'page' : 'false'); });
  renderView(tab);
  window.scrollTo(0, 0);
}
function renderView(tab = S.tab) {
  if (tab !== 'home') renderActionBar(null);
  if (tab === 'home') renderHome();
  else if (tab === 'plan') renderPlan();
  else if (tab === 'explore') renderExplore();
  else if (tab === 'map') renderMap();
}
async function renderMap() {
  const el = $('#view-map');
  if (!el.querySelector('#map')) {
    el.innerHTML = `<div class="mapwrap"><div id="map" role="application" aria-label="パークの地図"></div>
      <div class="mapbar">${[['all', 'すべて'], ['rides', '乗り物'], ['food', '食事'], ['shows', 'ショー']].map(([k, n]) => `<button class="chip ${S.mapFilter === k ? 'is-active' : ''}" data-mf="${k}">${n}</button>`).join('')}</div>
      <div class="mapfab"><button data-act="map-me" aria-label="現在地">${ic('locate')}</button><button data-act="map-fit" aria-label="パーク全体">${ic('expand')}</button></div>
      <div class="mapdest" id="mapcard"></div></div>`;
  }
  try {
    mapMod = mapMod || await import('./map.js');
    const c = ctx();
    const r = recommend(c);
    mapMod.draw({
      filter: S.mapFilter, pos: position(), gps: R.gpsPos && S.gps ? R.gpsPos : null,
      rides: ATTRACTIONS.map((a) => ({ a, pos: coordsOf(a.id), w: waitInfo(a), done: !!S.done[a.id] })),
      food: RESTAURANTS.map((x) => ({ r: x, pos: coordsOf(x.id) })),
      shows: SHOWS.map((s) => ({ s, pos: s.venuePos })),
      nextId: r.primary?.a?.id || null,
      icons: { food: ic('food'), show: ic('show') },
      coordsSrc: (() => { const n = Object.keys(R.meta?.coords || {}).filter((k) => attractionById[k]).length; return n >= 15 ? 'api' : n > 0 ? 'partial' : 'approx'; })(),
    });
    const p = r.primary;
    const dest = p?.type === 'ride' ? { name: p.a.short, pos: coordsOf(p.a.id), wait: p.wait, open: `data-open="${p.a.id}"` } : p?.type === 'anchor' ? { name: p.anchor.title + (p.anchor.place ? '・' + p.anchor.place : ''), pos: p.anchor.pos, open: `data-anchor-edit="${p.anchor.id}"` } : null;
    const me = position();
    $('#mapcard').hidden = !dest;
    if (dest) {
      $('#mapcard').innerHTML = `<button class="mapdest__b" style="text-align:left" ${dest.open}><div class="mapdest__k">NEXT</div><div class="mapdest__n">${esc(dest.name)}</div>
        <div class="mapdest__m">${me.lat != null ? `徒歩${walkMin(me, dest.pos)}分` : '現在地未設定'}${dest.wait != null ? ` · 待ち${dest.wait}分` : ''}${mapMod.coordsNote()}</div></button>
        <a class="btn btn--primary btn--sm" href="${routeUrl(dest.pos)}" target="_blank" rel="noopener">${ic('route')}ルート</a>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="note note--bad" style="margin:12px">${ic('alert')}<div>地図を読み込めませんでした（${esc(e.message)}）</div></div>`;
  }
}

function renderAll() { renderClock(); renderStatus(); renderView(); if (R.draft && !$('#sheet').hidden) openPlanBuilder(); }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-open]');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) return go(d.tab);
  if (d.tabGo) { closeSheet(); return go(d.tabGo); }
  if (d.open) return openAttraction(d.open);
  if (d.openFood) return openFood(d.openFood);
  if (d.openShow) return openShow(d.openShow);
  if (d.done) return markDone(d.done);
  if (d.undo) return undoDone(d.undo);
  if (d.add) { const how = d.addHow || R.addMode; closeSheet(); return addToPlan(d.add, how); }
  if (d.addMode) { R.addMode = d.addMode; return openAddSheet(); }
  if (d.mv) return moveInPlan(d.mv, Number(d.d));
  if (d.rm) return removeFromPlan(d.rm);
  if (d.mealDur) {
    S.prefs.mealOverrides[d.mealDur] = { ...(S.prefs.mealOverrides[d.mealDur] || {}), dur: Number(d.v) }; save(); renderView();
    return openAnchorEdit('meal:' + d.mealDur);
  }
  if (d.pin) {
    if (S.order) { S.order = [d.pin, ...S.order.filter((x) => x !== d.pin)]; }
    S.pin = { id: d.pin, until: nowMin() + 30 }; R.alerts = R.alerts.filter((x) => x.id !== d.pin); save();
    go('home'); return toast(`${attractionById[d.pin].short} を次の行き先にしました`, 'ok');
  }
  if (d.dismissAlert) { R.alerts = R.alerts.filter((x) => x.id !== d.dismissAlert); return renderHome(); }
  if (d.skip) return skipFor(d.skip);
  if (d.xtab) { S.exploreTab = d.xtab; save(); return renderExplore(); }
  if (d.xf) { S.exploreFilter = d.xf; save(); return renderExplore(); }
  if (d.ff) { S.foodFilter = d.ff; save(); return renderExplore(); }
  if (d.mf) { S.mapFilter = d.mf; save(); document.querySelectorAll('[data-mf]').forEach((b) => b.classList.toggle('is-active', b.dataset.mf === d.mf)); return renderMap(); }
  if (d.land) { S.land = d.land; S.landAt = Date.now(); save(); renderAll(); return toast(`現在地：${landById[d.land].ja}`, 'ok'); }
  if (d.rideSt) {
    const id = d.rideSt, must = mustMap();
    delete must[id]; delete S.excluded[id];
    if (d.v === 'must') must[id] = true;
    if (d.v === 'skip') S.excluded[id] = true;
    S.must = must; save(); renderView(); openAttraction(id);
    return toast(d.v === 'must' ? '絶対乗るに追加' : d.v === 'skip' ? '乗らないに設定' : 'おまかせに設定', 'ok');
  }
  if (d.anchorEdit) return openAnchorEdit(d.anchorEdit);
  if (d.pickShow) {
    S.prefs.shows[d.pickShow] = { ...(S.prefs.shows[d.pickShow] || {}), on: true, pick: d.time }; save(); renderAll();
    if (!$('#sheet').hidden) openShow(d.pickShow);
    return toast(`${showById[d.pickShow].short} ${d.time} の回に`, 'ok');
  }
  if (d.showOff) {
    S.prefs.shows[d.showOff] = { ...(S.prefs.shows[d.showOff] || {}), on: false }; save(); renderAll(); openShow(d.showOff);
    return toast(`${showById[d.showOff].short} をプランから外しました`);
  }
  if (d.saveTimes) {
    const v = $('#showTimesIn').value.split(/[,、\s]+/).map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x));
    if (v.length) S.prefs.showTimes[d.saveTimes] = v; else delete S.prefs.showTimes[d.saveTimes];
    save(); renderAll(); openShow(d.saveTimes); return toast(v.length ? '時刻を保存しました' : '自動の時刻に戻しました', 'ok');
  }
  if (d.manualSave) {
    const v = Number($('#manualWait').value);
    if (!Number.isFinite(v) || v < 0 || v > 300 || $('#manualWait').value === '') return toast('0〜300の数字を入力してください', 'error');
    S.manual[d.manualSave] = { wait: Math.round(v), at: Date.now() }; save(); closeSheet(); renderAll();
    return toast(`手入力：${attractionById[d.manualSave].short} 待ち${Math.round(v)}分（30分有効）`, "ok");
  }
  if (d.manualClear) { delete S.manual[d.manualClear]; save(); closeSheet(); renderAll(); return toast('手入力を消去しました'); }
  if (d.mealStep) {
    const { at } = mealCfg(d.mealStep);
    const v = Math.min(21 * 60, Math.max(8 * 60, at + Number(d.delta)));
    S.prefs.mealOverrides[d.mealStep] = { ...(S.prefs.mealOverrides[d.mealStep] || {}), at: v }; save(); renderView();
    return openAnchorEdit('meal:' + d.mealStep);
  }
  if (d.mealRest) {
    S.prefs.mealOverrides[d.mealRest] = { ...(S.prefs.mealOverrides[d.mealRest] || {}), restaurant: d.rest }; save(); renderView();
    return openAnchorEdit('meal:' + d.mealRest);
  }
  if (d.mealOff) {
    const o = S.prefs.mealOverrides[d.mealOff] = { ...(S.prefs.mealOverrides[d.mealOff] || {}) }; o.off = !o.off; save(); closeSheet(); renderAll();
    return toast(o.off ? '今日は省略にしました' : '予定に戻しました');
  }
  if (d.mealReset) { delete S.prefs.mealOverrides[d.mealReset]; save(); closeSheet(); renderAll(); return toast('初期設定に戻しました'); }
  // ---- plan builder (draft) ----
  if (d.bSet && R.draft) {
    if (d.bSet === 'plan') R.draft.plan = d.v;
    else R.draft.cond = { ...R.draft.cond, [d.bSet]: d.bSet === 'maxWait' ? Number(d.v) : d.v };
    return openPlanBuilder();
  }
  if (d.bRide && R.draft) {
    const id = d.bRide, D = R.draft;
    if (D.must[id]) { delete D.must[id]; D.excluded[id] = true; }
    else if (D.excluded[id]) delete D.excluded[id];
    else D.must[id] = true;
    return openPlanBuilder();
  }
  if (d.bShowPick && R.draft) {
    R.draft.prefs.shows[d.bShowPick] = { ...(R.draft.prefs.shows[d.bShowPick] || {}), on: true, pick: d.time };
    return openPlanBuilder();
  }
  switch (d.act) {
    case 'refresh': return fetchLive({ manual: true });
    case 'plan-edit': R.draft = null; return openPlanBuilder();
    case 'plan-edit-shows': R.draft = null; return openPlanBuilder('shows');
    case 'plan-apply': return applyPlanDraft();
    case 'plan-add': return openAddSheet();
    case 'plan-edit-order': R.planEdit = true; return renderPlan();
    case 'plan-edit-done': R.planEdit = false; return renderPlan();
    case 'plan-auto': { const sn = snapshot(); S.order = null; save(); renderAll(); return toast('おまかせのプランに戻しました', '', { label: '元に戻す', fn: () => restore(sn) }); }
    case 'prog-toggle': R.progOpen = !R.progOpen; return renderHome();
    case 'replan': {
      const before = R.lastPlanIds;
      await fetchLive({ manual: false });
      renderPlan();
      const changed = before !== R.lastPlanIds;
      return toast(R.liveStatus === 'error' ? '推定値で組み直しました' : changed ? '最新の待ち時間で組み直しました' : '組み直しました（変更なし）', R.liveStatus === 'error' ? 'error' : 'ok');
    }
    case 'gps-start': return startGPS(true);
    case 'gps-stop': return stopGPS();
    case 'pick-land': return openLandPicker();
    case 'sim-set': { const m = parseHHMM($('#simAt').value); S.sim = { base: m, setAt: Date.now() }; save(); closeSheet(); renderAll(); return toast(`${hhmm(m)} として表示中`, 'ok'); }
    case 'sim-off': S.sim = null; save(); closeSheet(); renderAll(); return toast('現在時刻に戻しました');
    case 'reset':
      if (!confirm('済みの記録とプランの条件をすべてリセットしますか？')) return;
      S = structuredClone(defaults); save(); closeSheet(); renderAll(); return toast('リセットしました');
    case 'map-me':
      if (!S.gps) return startGPS(true);
      return mapMod?.locate(R.gpsPos);
    case 'map-fit': return mapMod?.fit();
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.xsort !== undefined) { S.exploreSort = t.value; save(); renderExplore(); }
  if (d.gpsToggle !== undefined) { if (t.checked) startGPS(true); else stopGPS(); setTimeout(() => { if (!$('#sheet').hidden) openSettings(); }, 50); }
  if (R.draft) {
    const D = R.draft;
    if (d.bMealOn) { const o = D.prefs.mealOverrides[d.bMealOn] = { ...(D.prefs.mealOverrides[d.bMealOn] || {}) }; o.off = !t.checked; return openPlanBuilder(); }
    if (d.bMealRest) { D.prefs.mealOverrides[d.bMealRest] = { ...(D.prefs.mealOverrides[d.bMealRest] || {}), restaurant: t.value }; return openPlanBuilder(); }
    if (d.bMealAt) { D.prefs.mealOverrides[d.bMealAt] = { ...(D.prefs.mealOverrides[d.bMealAt] || {}), at: Number(t.value) }; return openPlanBuilder(); }
    if (d.bFirst !== undefined) { D.first = t.value; return openPlanBuilder(); }
    if (d.bMealDur) { D.prefs.mealOverrides[d.bMealDur] = { ...(D.prefs.mealOverrides[d.bMealDur] || {}), dur: Number(t.value) }; return openPlanBuilder(); }
    if (d.bShowOn) { D.prefs.shows[d.bShowOn] = { ...(D.prefs.shows[d.bShowOn] || {}), on: t.checked }; return openPlanBuilder(); }
  }
});
$('#settingsBtn').onclick = openSettings;
$('#livePill').onclick = () => fetchLive({ manual: true });

// =====================================================================
// Boot
// =====================================================================
function measure() {
  document.documentElement.style.setProperty('--hdr', $('.topbar').offsetHeight + 'px');
  document.documentElement.style.setProperty('--tabh', $('.tabbar').offsetHeight + 'px');
}
measure();
addEventListener('resize', measure);
go(S.tab || 'home');
renderStatus();
fetchMeta();
fetchPhotos();
const shouldPoll = () => { const m = nowMin(); return m >= hours().open - 90 && m <= hours().close + 30; };
fetchLive();
setInterval(() => { if (document.visibilityState === 'visible' && shouldPoll()) fetchLive(); }, 3 * 60e3);
setInterval(() => { renderClock(); renderStatus(); }, 15e3);
// Re-render the current view every minute so countdowns/plans follow the clock (skip while a sheet is open).
setInterval(() => { if ($('#sheet').hidden && S.tab !== 'map') renderView(); }, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderClock(); renderStatus(); if ($('#sheet').hidden) renderView();
    if (Date.now() - R.liveReceivedAt > 2 * 60e3) fetchLive();
  }
});
// Resume GPS automatically only if the user enabled it before AND the browser already granted permission.
if (S.gps && navigator.permissions?.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') startGPS(false); else { S.gps = false; save(); } }).catch(() => {});
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.__dlnavi = { S, R, ctx, recommend, simulateDay };

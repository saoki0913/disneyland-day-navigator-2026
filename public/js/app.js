import {
  TRIP, LANDS, landById, ATTRACTIONS, attractionById, RESTAURANTS, restaurantById, POPCORN, SHOWS, showById, PLANS, PRIORITY,
  PARK, PARK_ID, PARKS, PARK_ORDER, PARK_STORE,
} from './data.js';
import {
  recommend, simulateDay, planFromOrder, syncSequence, applyLocks, fitShows, buildAnchors, anchorConflicts, crowdRatio, rideRatios, walkMin, distanceM, hhmm, parseHHMM, estimateWait, availability, DEFAULT_MUST, gpsNeedsRedraw, movingPlanMin,
  optimizeOrder, insertMissing, pickNext, planCost, planMinutes, optimizePlan,
} from './engine.js';
import { SHARE_FIELDS, mergeDocs, sameDoc, newCode, CODE_RE } from './share.js';

// =====================================================================
// State (persisted in localStorage — never sent anywhere)
// =====================================================================
// One store per park (Disneyland keeps its original key so existing progress survives).
const KEY = PARK.storeKey;
const API_Q = `park=${PARK_ID}`;
const defaults = {
  plan: 'balance',
  done: {},            // { rideId | 'meal:lunch' | 'show:fantasmic': timestampMs }
  doneMin: {},         // { id: park-local minutes when completed } (for the timeline)
  doneDel: {},         // { id: ms } "未完了に戻す" — kept so a shared partner's phone also drops it
  fieldAt: {},         // { field: ms } last local change of each shared setting (two-phone sync)
  share: null,         // { code } two-person shared plan (null = this phone only)
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
  planTime: null,      // { base, setAt } manual starting time (moving clock)
  pin: null,           // { id, until } destination chosen from an alert
  order: null,         // [rideId, ...] ride order chosen by drag & drop on the plan (null → recommended order)
  locks: {},           // { rideId: true } rides locked in place (kept even when the plan is re-optimised)
  planSnap: null,      // the saved plan: { at, base, items, waiting, missingMust } — changes only on 更新 / 乗った / edits
  a2hsDismissed: false,
  exploreTab: 'rides', exploreFilter: 'all', exploreSort: 'reco', foodFilter: 'all', foodQ: '',
  mapFilter: 'rides',
  tab: 'home',
  cfg: { date: null, entry: null, exit: null }, // this park's trip date / entry / exit (minutes); null → plan/API value
  shareAdopted: false, // took over the other park's share code once
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
// save(): persist, and remember WHEN each shared setting last changed on this phone so that
// two phones sharing a plan can merge (newest change wins per setting).
let snap = null;
let noSave = false;
const snapOf = () => Object.fromEntries([...SHARE_FIELDS, 'done', 'doneDel'].map((k) => [k, JSON.stringify(S[k] ?? null)]));
function save() {
  if (noSave) return; // computing a rebuild proposal: nothing is stored or shared until 反映
  const cur = snapOf();
  let changed = false;
  if (snap) {
    for (const k of SHARE_FIELDS) if (cur[k] !== snap[k]) { S.fieldAt[k] = Date.now(); changed = true; }
    if (cur.done !== snap.done || cur.doneDel !== snap.doneDel) changed = true;
  }
  snap = cur;
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage full / private mode */ }
  if (changed && S.share) schedulePush();
}
snap = snapOf();

// Runtime (not persisted except caches)
const R = {
  live: null, liveStatus: 'idle', liveError: null, liveReceivedAt: 0,
  meta: null, photos: {},
  gpsPos: null, gpsErr: null, gpsBusy: false,
  dragging: false, pendingRender: false, flash: null, replanned: null,
  shareAt: 0, shareErr: null, shareBusy: false, sharePushTimer: 0,
  gpsRendered: null, gpsRenderedAt: 0,
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
  if (h?.date === tripDate()) R.hist = h.data || {};
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
  const selectedTime = movingPlanMin(S.planTime, Date.now());
  if (selectedTime != null) return selectedTime;
  const p = laParts();
  if (p.date < tripDate()) return hours().open - 60; // before the trip day: preview as morning
  if (p.date > tripDate()) return 24 * 60;
  return p.min;
}
function dayPhase() {
  const p = laParts();
  if (S.sim) return 'sim';
  if (S.planTime) return 'today';
  if (p.date < tripDate()) return 'before';
  if (p.date > tripDate()) return 'after';
  return 'today';
}
// ---------- trip day (date / entry / exit — user editable, per park) ----------
function tripDate() { return S.cfg?.date || TRIP.date; }
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function dateLabel(iso = tripDate()) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}
// Park operating hours on the trip date: official schedule (API) → plan value.
function parkHours() {
  const sc = R.meta?.schedule;
  const op = sc?.days ? sc.days[tripDate()]?.operating : sc?.date === tripDate() ? sc.operating : null;
  if (op && op.open != null && op.close != null) return { open: op.open, close: op.close === 0 ? 24 * 60 : op.close, src: 'api' };
  return { open: TRIP.openMin, close: TRIP.closeMin, src: 'plan' };
}
// The window the plan uses: the user's entry / exit when set, otherwise park opening / closing.
function hours() {
  const ph = parkHours();
  const e = S.cfg?.entry, x = S.cfg?.exit;
  const open = Number.isFinite(e) ? e : ph.open;
  const close = Number.isFinite(x) ? x : ph.close;
  const base = { src: ph.src, parkOpen: ph.open, parkClose: ph.close };
  if (close - open < 60) return { ...base, open: ph.open, close: ph.close, customOpen: false, customClose: false };
  return { ...base, open, close, customOpen: Number.isFinite(e), customClose: Number.isFinite(x) };
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
const PARK_CENTER = PARK.center;
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
    const res = await fetch('/api/live?' + API_Q, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.errors?.join(' / ') || `HTTP ${res.status}`);
    if (!j.stale) { detectAlerts(R.live?.ok && !R.live.stale ? R.live : null, j); recordHistory(j); }
    R.live = j; R.liveReceivedAt = Date.now(); R.liveStatus = j.stale ? 'stale' : 'ok'; R.liveError = j.stale ? (j.errors || []).join(' / ') : null;
    localStorage.setItem(KEY + ':live', JSON.stringify({ at: R.liveReceivedAt, data: j }));
    if (manual) toast(j.stale ? '最新取得に失敗：前回の値を表示中' : `待ち時間を更新しました（${j.sourceLabel}）`, j.stale ? 'error' : 'ok');
    if (!j.stale && R.firstAuto && S.planSnap?.why === '初回' && !doneRides().length) { R.firstAuto = false; buildPlan('初回'); }
    R.firstAuto = false;
    if (!j.stale) { syncPaused(); checkSuggest(); }
    R.livePrimed = true;
  } catch (e) {
    R.liveStatus = 'error';
    R.liveError = e.name === 'AbortError' ? 'タイムアウト' : e.message;
    if (manual) toast('待ち時間を取得できませんでした。推定値で案内します', 'error');
  }
  renderAll();
}
// Pauses: the plan's order and contents never change here. A paused ride stays in its place marked
// 「休止中」 (taking no time, the next stop skips it); when it reopens it simply counts again. Times are refreshed.
const BOOT_AT = Date.now();
function syncPaused() {
  if (!S.planSnap?.items) return;
  if (R.dragging) { R.pausedPending = true; return; }
  const c = ctx();
  if (c.now < c.openMin || c.now >= c.closeMin) return;
  const seq = planSeq();
  const down = seq.filter((id) => attractionById[id] && !S.done[id] && !availability(attractionById[id], c).ok);
  const was = (S.planSnap.waiting || []).filter((id) => !S.done[id]);
  const paused = down.filter((id) => !was.includes(id));
  const back = was.filter((id) => !down.includes(id) && seq.includes(id));
  if (!paused.length && !back.length) return;
  // first live data after opening the app: the plan was just made without it — adjust quietly
  const quiet = !R.livePrimed && S.planSnap.at >= BOOT_AT;
  R.livePrimed = true;
  layoutPlan(seq, back.length ? '再開' : '休止');
  if (quiet) return;
  const names = (ids) => ids.map((id) => attractionById[id].short).join('・');
  const parts = [];
  if (paused.length) parts.push(`${names(paused)} 一時休止`);
  if (back.length) parts.push(`${names(back)} 再開`);
  R.replanned = { at: Date.now(), text: `${clock(nowMin())} ${parts.join(' / ')}` };
  R.flash = { at: Date.now(), ids: new Set(back) };
  if (paused.length) paused.forEach((id) => R.noteSeen.add(`${id}:tmp`)); // already announced here
  toast(parts.join(' / '), back.length ? 'ok' : 'warn');
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
  try { localStorage.setItem(KEY + ':hist', JSON.stringify({ date: tripDate(), data: R.hist })); } catch { /* full */ }
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
    const res = await fetch('/api/meta?' + API_Q);
    const j = await res.json();
    if (j?.ok) { R.meta = j; localStorage.setItem(KEY + ':meta', JSON.stringify({ at: Date.now(), data: j })); renderAll(); }
  } catch { /* fallback coords stay in use */ }
}
async function fetchPhotos() {
  // cached set is complete enough (incl. the dish photos added later) → no refetch
  if (Object.keys(R.photos).length > 20 && Object.keys(R.photos).some((k) => k.startsWith('menu_') || k === '_menuChecked')) return;
  const sets = await Promise.allSettled(['rides', 'food', 'food2', 'shows', 'menu'].map((set) => fetch(`/api/photos?set=${set}&${API_Q}`).then((r) => r.json())));
  const merged = { ...R.photos };
  for (const s2 of sets) if (s2.status === 'fulfilled' && s2.value?.ok) { Object.assign(merged, s2.value.photos); if (s2.value.set === 'menu') merged._menuChecked = { source: 'none' }; }
  if (Object.keys(merged).length) {
    R.photos = merged;
    localStorage.setItem(KEY + ':photos', JSON.stringify({ at: Date.now(), data: merged }));
    renderAll();
  }
}
const credit = (key) => { const p = R.photos?.[key]; if (!p) return ''; return `Photo: ${[p.author, p.license].filter(Boolean).join(' · ') || p.title} / ${p.source || 'Wikimedia'}`; };

// ---------- GPS ----------
// No continuous tracking (watchPosition keeps the GPS radio on and drains the battery).
// Instead: single fixes, only while the app is visible and the user has turned GPS on,
// at most every 60 s on the map tab and every 3 min elsewhere (plus when the user taps "現在地").
const GPS_EVERY = () => (S.tab === 'map' ? 60e3 : 180e3);
const gpsDue = () => !R.gpsPos || Date.now() - R.gpsPos.at > GPS_EVERY() * 0.8;
function requestFix({ userInitiated = false, force = false } = {}) {
  if (!('geolocation' in navigator)) {
    R.gpsErr = 'この端末・ブラウザは位置情報に対応していません';
    if (userInitiated) toast(R.gpsErr, 'error');
    renderAll(); return;
  }
  if (R.gpsBusy || document.visibilityState === 'hidden') return;
  if (!userInitiated && !force && (!S.gps || !gpsDue())) return;
  R.gpsBusy = true; R.gpsErr = null;
  if (userInitiated && !R.gpsPos) toast('位置情報の許可を確認しています…');
  const onMap = S.tab === 'map';
  navigator.geolocation.getCurrentPosition((p) => {
    R.gpsBusy = false;
    R.gpsPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
    if (!S.gps) { S.gps = true; save(); }
    if (userInitiated) toast(`現在地を取得しました（精度 約${Math.round(p.coords.accuracy)}m）`, 'ok');
    if (S.tab === 'map') {
      renderMap();
      if (userInitiated) mapMod?.locate(R.gpsPos);
    } else if (userInitiated || gpsNeedsRedraw(R.gpsRendered, R.gpsPos, R.gpsPos.at - R.gpsRenderedAt)) {
      // GPS noise should not repaint the page.
      R.gpsRendered = R.gpsPos; R.gpsRenderedAt = R.gpsPos.at;
      renderAll();
    }
  }, (err) => {
    R.gpsBusy = false;
    R.gpsErr = err.code === 1 ? '位置情報が許可されていません（設定から許可するか、エリアを手動で選んでください）' : err.code === 3 ? '位置情報の取得がタイムアウトしました' : '位置情報を取得できませんでした';
    if (err.code === 1) { S.gps = false; R.gpsPos = null; R.gpsRendered = null; R.gpsRenderedAt = 0; save(); }
    if (userInitiated) toast(R.gpsErr, 'error');
    renderAll();
  }, {
    // High accuracy only when it matters (looking at the map or explicitly asked); reuse a recent fix otherwise.
    enableHighAccuracy: onMap || userInitiated,
    maximumAge: userInitiated ? 10e3 : onMap ? 30e3 : 90e3,
    timeout: 15000,
  });
}
function startGPS(userInitiated = false) { requestFix({ userInitiated, force: true }); }
function stopGPS() {
  R.gpsPos = null; R.gpsRendered = null; R.gpsRenderedAt = 0; R.gpsErr = null; S.gps = false; save(); renderAll();
  toast('位置情報の利用を停止しました');
}
// Turn GPS on silently if the browser already granted permission (never triggers a prompt).
function gpsIfGranted() {
  if (S.gps || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') requestFix({ force: true }); }).catch(() => {});
}

// ---------- engine context ----------
function showTimesFor(id) {
  const manual = S.prefs.showTimes?.[id];
  if (manual?.length) return { times: manual, src: 'manual' };
  const api = R.live?.shows?.[id]?.times?.filter((t) => !t.date || t.date === tripDate()).map((t) => hhmm(t.start));
  if (api?.length) return { times: [...new Set(api)], src: 'api' };
  return { times: showById[id].times, src: 'pre' };
}
function anchors() {
  const showTimes = {};
  for (const s of SHOWS) showTimes[s.id] = showTimesFor(s.id).times;
  return fitAnchors(buildAnchors(S.plan, { ...S.prefs, showTimes }, S.done));
}
// Restaurants use the API coordinates (same as the map pins) so home / plan / map route agree,
// and meals / shows that start after the exit time are left out of the plan. (Ones before the entry
// time are already treated as over by the planner; a dragged meal is briefly at 0:00 = "on arrival".)
function fitAnchors(list) {
  const h = hours();
  for (const x of list) if (x.restaurant) { const c = coordsOf(x.restaurant); if (c) x.pos = { lat: c.lat, lon: c.lon }; }
  return list.filter((x) => x.done || x.start < h.close);
}
function outsideAnchors() {
  const showTimes = {};
  for (const s of SHOWS) showTimes[s.id] = showTimesFor(s.id).times;
  const kept = new Set(anchors().map((x) => x.id));
  return buildAnchors(S.plan, { ...S.prefs, showTimes }, S.done).filter((x) => !kept.has(x.id));
}
const mustMap = () => S.must || { ...DEFAULT_MUST };
const MEAL_FLEX = 60;
function ctx(extra = {}) {
  const h = hours();
  const live = liveMap();
  const now = nowMin();
  return {
    now, openMin: h.open, closeMin: h.close, pos: (() => { const p = position(); return p.lat == null ? null : p; })(),
    planId: S.plan, done: S.done, excluded: S.excluded, skip: S.skip, live, crowd: crowdRatio(live, now),
    rideRatio: now >= h.open ? rideRatios(live, now) : {}, liveAt: now,
    // "Next" follows the saved plan (same on both phones); a fresh plan is built from the user's own order.
    order: S.planSnap?.items ? S.planSnap.items.filter((i) => i.type === 'ride' && !S.done[i.id]).map((i) => i.id) : S.order,
    orderReason: S.planSnap?.items ? { k: 'plan', t: 'プランの順番' } : null,
    anchors: anchors(), coords: coordsMap(), pin: S.pin, must: mustMap(), cond: S.cond,
    mealFlex: MEAL_FLEX, // meals may move up to ±60 min (a time you set yourself stays fixed)
    ...extra,
  };
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
  grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c3 .2 5.5 2.7 5.5 5.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
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
// Every place to eat, grouped (meals first) — any of them can be chosen for any meal.
const KIND_JA = { meal: '食事', cafe: 'カフェ', snack: '軽食', sweets: 'スイーツ' };
const KIND_ORDER = ['meal', 'cafe', 'snack', 'sweets'];
function shopGroups(firstKind = 'meal', from = null) {
  const order = [firstKind, ...KIND_ORDER.filter((k) => k !== firstKind)];
  return order.map((k) => ({ k, label: KIND_JA[k], list: RESTAURANTS.filter((r) => r.kind === k)
    .map((r) => ({ r, walk: walkMin(from, coordsOf(r.id)) })).sort((x, y) => x.walk - y.walk || x.r.ja.localeCompare(y.r.ja, 'ja')) }))
    .filter((g) => g.list.length);
}
// Dish photo (Wikimedia Commons) or an emoji tile when none was found.
function dishImg(r, i) {
  const p = R.photos?.[`menu_${r.id}_${i}`];
  return p?.src ? `<img class="dish__img" src="${esc(p.src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'dish__img dish__img--none',textContent:'${r.emoji || ''}'}))">`
    : `<span class="dish__img dish__img--none" aria-hidden="true">${esc(r.emoji || '')}</span>`;
}
const showImgKey = (id) => (PARK_ID === 'dl' ? (id === 'fantasmic' ? 'fantasmic' : id === 'fireworks' ? 'fireworks' : 'cavalcade') : id);
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

// Walking directions in Google Maps. Start = this phone's latest GPS fix when we have one
// (otherwise Google Maps starts from "your location").
function routeUrl(pos) {
  const g = S.gps && R.gpsPos && Date.now() - R.gpsPos.at < 5 * 60e3 ? R.gpsPos : null;
  return `https://www.google.com/maps/dir/?api=1${g ? `&origin=${g.lat.toFixed(6)},${g.lon.toFixed(6)}` : ''}&destination=${pos.lat},${pos.lon}&travelmode=walking`;
}
const routeAttr = (pos) => (pos ? `href="${esc(routeUrl(pos))}" data-route="${pos.lat},${pos.lon}" target="_blank" rel="noopener"` : 'aria-disabled="true"');
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
  // Pressing "乗った" on the day means it really is now: drop a manually chosen start time
  // so the rest of the plan restarts from this moment and this place.
  if (S.planTime && !S.sim && laParts().date === tripDate()) S.planTime = null;
  if (S.gps) requestFix({ force: true });
  // the order stays as it is; only the times after it are recalculated (a better order → suggestion card)
  relayout('乗った'); checkSuggest();
  renderAll();
  // Fresh waits for the re-plan (the edge cache makes this cheap); time it again with them.
  if (Date.now() - R.liveReceivedAt > 60e3 && shouldPoll()) fetchLive().then(() => { if (S.done[id]) { relayout('乗った'); checkSuggest(); renderAll(); } });
  const n = doneRides().length;
  toast(`${doneName(id)} 完了${attractionById[id] ? `（${n}つ目）` : ''}`, 'ok', { label: '取り消す', fn: () => undoDone(id, true) });
}
function undoDone(id, silent = false) {
  const prev = { at: S.done[id], min: S.doneMin[id] };
  delete S.done[id]; delete S.doneMin[id];
  S.doneDel[id] = Date.now();
  if (S.lastDone?.id === id) S.lastDone = null;
  relayout('未完了に戻す'); renderAll();
  if (!silent) toast(`${doneName(id)} を未完了に戻しました`, '', { label: '完了に戻す', fn: () => { S.done[id] = Date.now(); S.doneMin[id] = prev.min; relayout('乗った'); renderAll(); } });
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
  if (S.planSnap?.seq) {
    const prev = planSeq();
    const open = prev.filter((x) => !S.done[x]);
    const i = open.indexOf(id);
    // move it behind the next ride that is actually shown (not a meal/show, not one waiting to reopen),
    // and keep it out of gap suggestions for a while
    const waiting = new Set(S.planSnap.waiting || []);
    const j = open.findIndex((x, k) => k > i && attractionById[x] && !waiting.has(x));
    if (i >= 0 && j > i) {
      // bring the next ride forward (meals / shows keep their places)
      const nid = open[j];
      open.splice(j, 1); open.splice(i, 0, nid);
      S.skip[id] = nowMin() + minutes;
      layoutPlan([...prev.filter((x) => S.done[x]), ...open], '並べ替え'); renderAll();
      return toast(`${itemLabel(id)} を後ろへ`, '', { label: '戻す', fn: () => { delete S.skip[id]; layoutPlan(prev, '並べ替え'); renderAll(); } });
    }
  }
  S.skip[id] = nowMin() + minutes; save(); renderAll();
  if (S.planSnap?.seq) return toast('プランにほかの乗り物がありません（「ほかの候補」から追加できます）', 'warn');
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
  if (R.updateReady) return;
  const phase = dayPhase();
  let msg = '', err = false;
  if (phase === 'sim') msg = `テスト時刻 ${clock(nowMin())}`;
  else if (S.planTime) msg = `指定時刻 ${clock(nowMin())} から案内中 · プランで変更できます`;
  else if (phase === 'before') msg = '当日の朝としてプレビュー中';
  else if (phase === 'after') msg = `${dateLabel()}の${PARK.short}は終了しました`;
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
  soft: ['場所取り短め', 'warn'], close: ['閉園前に並べばOK', 'warn'], pin: ['あなたが選択', 'must'], order: ['あなたの順番', 'must'], plan: ['プラン通り', ''], lock: ['固定', 'must'], gap: ['空き時間に', 'live'],
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
  const r = homeReco(c);
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
  // 1) next action — always first
  html += renderNextCard(r, c);
  // 2) progress: one slim band; tap to open the details
  html += progressBand(c, done);
  html += suggestCard();
  if (c.now < h.open) {
    html += `<div class="card cdrow">${ic('clock')}<span>${h.customOpen ? '入園' : '開園'} <b class="num">${clock(h.open)}</b> まで <b>${fmtDur(h.open - c.now)}</b> · ${h.customOpen ? `開園 <span class="num">${clock(h.parkOpen)}</span>` : `入口に <span class="num">${clock(h.open - 40)}</span> 着が目安`}</span></div>`;
  }
  // 3) only actionable alerts stay on screen: reopened / suddenly shorter
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
  noteToasts(r);
}

// Progress band: done / planned + the next meal or show, in one slim line. Tap → upcoming list + must rides.
function progressBand(c, done) {
  const items = planItems();
  const rides = items.filter((i) => i.type === 'ride').length;
  const total = Math.max(done.length + rides, done.length);
  const pct = Math.min(100, (done.length / Math.max(1, total)) * 100);
  const up = items.filter(isUpcoming(c));
  const fixed = up.find((i) => i.type !== 'ride');
  const live = liveMap();
  const musts = Object.keys(mustMap()).filter((id) => attractionById[id]);
  const nm = (i) => (i.a ? i.a.short : i.anchor.title + (i.type === 'meal' && i.anchor.place ? `（${i.anchor.place.split('・')[0]}）` : ''));
  return `<div class="card pband ${R.progOpen ? 'is-open' : ''}">
    <button class="pband__h" type="button" data-act="prog-toggle" aria-expanded="${!!R.progOpen}">
      <span class="prog__n">${done.length}<small>/${total}</small></span>
      <span class="pband__bar"><i style="width:${pct}%"></i></span>
      <span class="pband__s">${fixed ? `<span class="num">${clock(fixed.anchor.start)}</span> ${esc(fixed.anchor.title)}` : `残り${Math.max(0, total - done.length)}`}</span>
      <span class="pband__chev">${ic('chev')}</span></button>
    ${R.progOpen ? `<div class="pband__body">
      ${musts.length ? `<div class="musts">${musts.map((id) => {
        const down = !S.done[id] && live[id] && live[id].status !== 'OPERATING' && c.now >= c.openMin;
        return `<span class="must ${S.done[id] ? 'is-done' : down ? 'is-down' : ''}">${S.done[id] ? ic('check') : ic('star')}${esc(attractionById[id].short)}${down ? '（休止）' : ''}</span>`;
      }).join('')}</div>` : ''}
      <ol class="mini">${up.slice(0, 6).map((i) => `<li class="mini__i mini__i--${i.type}"><span class="num">${clock(i.type === 'ride' ? i.start : i.anchor.start)}</span><span class="mini__n">${esc(nm(i))}</span>${i.type === 'ride' ? `<span class="mini__w">待ち${i.wait}分</span>` : ''}</li>`).join('') || '<li class="mini__i">予定はもうありません</li>'}</ol>
      <button class="btn btn--sm btn--block" data-tab-go="plan">${ic('edit')}プランを見る・編集</button>
    </div>` : ''}
  </div>`;
}

// Non-actionable notices (休止中・入りきらない) appear once as a snackbar instead of staying on the screen.
function noteToasts(r) {
  const missing = (planSnapshot().missingMust || []).filter((id) => !S.done[id]);
  const msgs = r.notes.map((n) => [`${n.id}:${n.fit ? 'fit' : n.temporary ? 'tmp' : 'off'}`, `${n.text}${n.fit ? '（あとで案内）' : n.temporary ? '（再開したら案内）' : ''}`]);
  if (missing.length && !r.notes.length) msgs.push(['miss:' + missing.join(), `${missing.map((id) => attractionById[id].short).join('・')} がプランに入りきらない`]);
  const late = (planSnapshot().late || []).filter((id) => !S.done[id]);
  if (late.length) msgs.push(['late:' + late.join(), `この順番だと ${late.map((id) => itemLabel(id)).join('・')} に間に合いません`]);
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
      <button class="actionbar__main" data-done="${p.a.id}">${ic('check')}<span class="ab__n">${jw(p.a.short)}</span><b class="ab__v">乗った</b></button>`;
  } else {
    const x = p.anchor;
    bar.innerHTML = `<button class="actionbar__side" data-anchor-edit="${x.id}" aria-label="変更">${ic('edit')}変更</button>
      <button class="actionbar__main" data-done="${x.id}">${ic('check')}<span class="ab__n">${jw(x.title)}</span><b class="ab__v">${x.kind === 'show' ? '観た' : '食べた'}</b></button>`;
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
        <a class="btn" ${routeAttr(coordsOf(a.id))}>${ic('route')}ルート</a>
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
        <a class="btn" ${routeAttr(x.pos)}>${ic('route')}ルート</a>
        ${rest ? `<button class="btn" data-open-food="${rest.id}">${ic('food')}メニュー</button>` : `<button class="btn" data-open-show="${x.show}">${ic('info')}くわしく</button>`}
      </div></article>`;
  }

  const nearSnacks = RESTAURANTS.filter((x) => x.kind === 'sweets' || x.kind === 'snack')
    .map((x) => ({ x, w: walkMin(c.pos, coordsOf(x.id)) })).sort((a, b) => a.w - b.w).slice(0, 4);
  return `<article class="card next">
    <div><div class="kicker">Free time</div><h1 class="next__title">${next ? `${esc(next.title)}まで ${fmtDur(p.minutes)}` : '自由時間'}</h1>
      <div class="next__en">おやつ・写真・お土産に</div></div>
    ${next ? `<div class="tags"><span class="tag tag--warn">${clock(r.leaveBy)} に移動開始</span></div>
    <div class="nextstop"><div class="nextstop__t"><span class="kicker">Next · ${clock(next.start)}</span><b>${jw(next.kind === 'meal' ? `${next.title}：${next.place}` : next.title)}</b><small>${ic('walk')}徒歩${walkMin(c.pos, next.pos)}分${next.claim ? ` · 場所取り ${clock(next.start - next.claim)}〜` : ''}</small></div></div>
    <div class="btnrow">
      <a class="btn btn--primary" ${routeAttr(next.pos)}>${ic('route')}ルート</a>
      ${next.restaurant ? `<button class="btn" data-open-food="${next.restaurant}">${ic('food')}メニュー</button>` : next.show ? `<button class="btn" data-open-show="${next.show}">${ic('info')}くわしく</button>` : ''}
    </div>` : ''}
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

// ---------- the saved plan ----------
// The timeline is NOT recalculated on its own (opening the tab, the clock, new wait times or GPS
// never reshuffle it). It is rebuilt only when the user presses 更新 / 乗った or edits the plan,
// and it is shared as-is with the partner's phone so both show exactly the same plan.
function snapItem(it) {
  if (it.type === 'ride') return { type: 'ride', id: it.id, start: it.start, end: it.end, wait: it.wait, waitKind: it.waitKind, walk: it.walk, must: !!it.must, over: !!it.over, paused: !!it.paused };
  if (it.type === 'free') return { type: 'free', start: it.start, end: it.end };
  return { type: it.type, id: it.id, start: it.start, end: it.end, claimFrom: it.claimFrom ?? null, walk: it.walk, anchor: { ...it.anchor } };
}
const SEQ_TYPES = ['ride', 'meal', 'show'];
// The plan IS a sequence (rides, meals, shows). Times are recalculated from it; the order only
// changes when the user moves something, or presses 更新 / changes conditions (locked rides stay).
function layoutPlan(seq, why, opts = {}) {
  const prevStarts = opts.starts || Object.fromEntries((S.planSnap?.items || []).filter((i) => i.id).map((i) => [i.id, i.start]));
  // Times-only updates keep each meal at its planned time (later only if you are running late);
  // the ±60 min window is used only when a plan is made / rebuilt (opts.flex).
  const c = ctx({ order: null, orderReason: null, ...(opts.flex ? {} : { mealFlex: 0 }) });
  if (!opts.flex) {
    const planned = Object.fromEntries((S.planSnap?.items || []).filter((i) => i.type === 'meal').map((i) => [i.id, i.start]));
    c.anchors = c.anchors.map((a) => (a.kind === 'meal' && !a.fixed && planned[a.id] != null ? { ...a, start: planned[a.id], end: planned[a.id] + (a.end - a.start) } : a));
  }
  // optional blocks the recommended plan gave up (e.g. cavalcade for a must-ride) stay out until re-added
  const dropped = (opts.dropped || S.planSnap?.dropped || []).filter((id) => !seq.includes(id));
  // meals/shows already over (and not in the plan) are not brought back
  const base = Math.max(c.now, c.openMin);
  seq = syncSequence(seq, c.anchors.filter((a) => !a.done && !dropped.includes(a.id) && (seq.includes(a.id) || a.end > base)), prevStarts);
  const r = planFromOrder(c, seq);
  S.planSnap = { at: Date.now(), made: S.planSnap?.made ?? Math.round(c.now), base: Math.round(Math.max(c.now, c.openMin)), why, seq, dropped, items: r.items.map(snapItem), waiting: r.waiting, missingMust: r.missingMust, late: r.late };
  save();
  return S.planSnap;
}
// Full re-optimisation (first plan, 更新, conditions, start time): the draft decides WHICH rides fit the
// day, the route optimiser decides the ORDER (short walks, rides grouped by area, must-rides wherever they
// fit best). Locked rides keep their place.
function buildPlan(why = '') {
  const c = ctx({ order: S.order, orderReason: null });
  const sim = simulateDay(c);
  const c2 = ctx({ order: null, orderReason: null });
  const prev = S.planSnap?.seq || [];
  const dropped = sim.items.filter((i) => i.type === 'dropped').map((i) => i.id);
  const starts = Object.fromEntries(sim.items.filter((i) => i.id).map((i) => [i.id, i.start]));
  const base = Math.max(c2.now, c2.openMin);
  let seq = [...sim.items.filter((i) => SEQ_TYPES.includes(i.type)).map((i) => i.id), ...(sim.waiting || [])];
  seq = syncSequence(seq, c2.anchors.filter((a) => !a.done && !dropped.includes(a.id) && a.end > base), starts);
  seq = insertMissing(c2, seq, sim.missingMust || []);
  seq = applyLocks(seq, prev, S.locks, S.done);
  for (const id of Object.keys(S.locks || {})) if (S.locks[id] && !seq.includes(id) && !S.done[id] && prev.includes(id)) seq.push(id);
  // a ride chosen as "first" in the condition builder stays first
  const first = S.order?.[0];
  const locks = { ...S.locks, ...(first && seq.find((x) => !S.done[x]) === first ? { [first]: true } : {}) };
  seq = fitShows(c2, seq);
  // which rides and in what order: value of each ride vs. walking / queueing / meals moved / shows
  seq = optimizePlan(c2, seq, { locks, budgetMs: 600 }).seq;
  seq = applyLocks(seq, prev, S.locks, S.done); // a locked ride keeps its place even when rides were added before it
  seq = fitShows(c2, seq);
  // it must fit: rides pushed past closing drop out (locked / must stay and are flagged)
  const over = new Set(planFromOrder(c2, seq).items.filter((i) => i.over && !S.locks?.[i.id] && !mustMap()[i.id]).map((i) => i.id));
  seq = seq.filter((id) => !over.has(id));
  R.suggest = null;
  const snap = layoutPlan(seq, why, { starts, dropped, flex: true });
  snap.made = Math.round(nowMin());
  save();
  return snap;
}
// After 乗った / a new position: pick only the NEXT stop again from here; the rest keeps its order.
function nextFromHere(why) {
  if (!S.planSnap?.items) { buildPlan(why); return; }
  const before = planSeq();
  const c = ctx({ order: null, orderReason: null });
  const seq = pickNext(c, before, S.locks);
  layoutPlan(seq, why);
  markMoves(before, seq);
  checkSuggest();
}
// Show which rows moved (↑ earlier / ↓ later) for a few seconds — no sentence needed.
function markMoves(before, after) {
  const b = before.filter((x) => !S.done[x]), a = after.filter((x) => !S.done[x]);
  const map = {};
  a.forEach((id, i) => {
    const j = b.indexOf(id);
    if (j < 0) map[id] = 'new';
    else if (j > i) map[id] = 'up';
    else if (i - j >= 2) map[id] = 'down'; // a one-step shift caused by another ride jumping ahead is noise
  });
  R.moves = Object.keys(map).length ? { at: Date.now(), map } : null;
  if (R.moves) R.flash = { at: Date.now(), ids: new Set(Object.keys(map)) };
}
// A clearly better order (≥ 15 min less walking/waiting) is OFFERED, never applied on its own.
const SUGGEST_MIN = 15;
function checkSuggest() {
  R.suggest = null;
  if (!S.planSnap?.items || R.dragging || R.planEdit) return;
  const c = ctx({ order: null, orderReason: null });
  if (c.now < c.openMin || c.now >= c.closeMin - 30) return;
  const cur = planSeq();
  // 1) a clearly better order of the same rides
  const o = optimizeOrder(c, cur, S.locks);
  if (o.seq.join() === cur.join() || o.cost >= o.before) return suggestAdditions(c, cur);
  // shown in real minutes; a big drop in penalties means something that was late / not fitting now fits
  const gain = Math.round(planMinutes(c, cur) - planMinutes(c, o.seq));
  const fixes = o.before - o.cost - Math.max(0, gain) >= 300;
  if (gain < SUGGEST_MIN && !fixes) return suggestAdditions(c, cur);
  const sig = o.seq.filter((x) => !S.done[x]).join();
  if (S.suggestOff === sig) return suggestAdditions(c, cur);
  R.suggest = { seq: o.seq, from: cur, gain, fixes, sig };
}
// 2) free time that rides could fill (e.g. a planned ride paused): offer to ADD them — nothing is removed
function suggestAdditions(c, cur) {
  const add = optimizePlan(c, cur, { locks: S.locks, budgetMs: 250, keep: true });
  const added = add.seq.filter((id) => attractionById[id] && !cur.includes(id));
  if (!added.length) return;
  const sig = 'add:' + add.seq.filter((x) => !S.done[x]).join();
  if (S.suggestOff !== sig) R.suggest = { seq: add.seq, from: cur, gain: 0, added, sig };
}
function applySuggest() {
  const sg = R.suggest; if (!sg) return;
  const sn = editSnapshot();
  layoutPlan(sg.seq, '提案');
  markMoves(sg.from, sg.seq);
  R.suggest = null; R.replanned = { at: Date.now() };
  renderAll();
  toast(sg.gain >= 1 ? `−${sg.gain}分` : '並べ替えました', 'ok', { label: '元に戻す', fn: () => restoreEdit(sn) });
}
// Both layouts of a suggestion (now vs proposed), for the card and the preview sheet.
function suggestLayouts(sg) {
  const c = ctx({ order: null, orderReason: null });
  const lay = (seq) => planFromOrder(c, seq).items.filter((i) => SEQ_TYPES.includes(i.type) && !i.over);
  const cur = lay(sg.from), nxt = lay(sg.seq);
  const sum = (items, f) => items.reduce((t, i) => t + (f(i) || 0), 0);
  return {
    cur, nxt,
    walk: [sum(cur, (i) => i.walk), sum(nxt, (i) => i.walk)],
    wait: [sum(cur, (i) => i.type === 'ride' && i.wait), sum(nxt, (i) => i.type === 'ride' && i.wait)],
    startOf: Object.fromEntries(cur.map((i) => [i.id, i.type === 'ride' ? i.start : i.anchor.start])),
  };
}
function suggestCard() {
  const sg = R.suggest; if (!sg) return '';
  const L = suggestLayouts(sg);
  const curIds = L.cur.map((i) => i.id);
  if (sg.added?.length) {
    const at = (id) => L.nxt.find((i) => i.id === id)?.start;
    return `<div class="card sugg" role="status"><button class="sugg__open" data-act="suggest-preview" aria-label="追加案を見る">
      <span class="sugg__gain">${ic('plus')}<b class="num">${sg.added.length}</b></span>
      <span class="sugg__seq">${sg.added.slice(0, 2).map((id) => `<span class="sugg__chip">${esc(itemLabel(id))}</span>${at(id) != null ? `<span class="sugg__t num">${clock(at(id))}</span>` : ''}`).join('')}<span class="sugg__t">空き時間に追加</span></span>
      <span class="sugg__go">${ic('chev')}</span></button>
      <button class="alert__x" data-act="suggest-off" aria-label="追加しない">${ic('x')}</button></div>`;
  }
  // the item that jumps furthest forward is what the suggestion is "about"
  const first = L.nxt.map((i, k) => ({ i, d: curIds.indexOf(i.id) - k + (i.type === 'ride' ? 0.5 : 0) })).filter((x) => x.d > 0.5).sort((x, y) => y.d - x.d)[0]?.i;
  const t0 = first && L.startOf[first.id], t1 = first && (first.type === 'ride' ? first.start : first.anchor.start);
  const gain = sg.gain >= 1 ? `<b class="num">−${sg.gain}</b><small>分</small>` : ic('check');
  return `<div class="card sugg" role="status"><button class="sugg__open" data-act="suggest-preview" aria-label="変更後のプランを見る">
    <span class="sugg__gain">${ic('refresh')}${gain}</span>
    <span class="sugg__seq">${first ? `<span class="mv mv--up">↑</span><span class="sugg__chip">${esc(itemLabel(first.id))}</span>${t0 != null ? `<span class="sugg__t num"><s>${clock(t0)}</s>${ic('chev')}${clock(t1)}</span>` : ''}` : ''}</span>
    <span class="sugg__go">${ic('chev')}</span></button>
    <button class="alert__x" data-act="suggest-off" aria-label="今の順番のまま">${ic('x')}</button></div>`;
}
// Preview: the proposed timeline, with what moves and how the times change.
function openSuggestPreview() {
  const sg = R.suggest; if (!sg) return;
  const L = suggestLayouts(sg);
  const curIds = L.cur.map((i) => i.id);
  const row = (it, k) => {
    const j = curIds.indexOf(it.id);
    const mvk = j < 0 ? 'new' : j > k ? 'up' : k - j >= 2 ? 'down' : '';
    const t = it.type === 'ride' ? it.start : it.anchor.start;
    const t0 = L.startOf[it.id];
    const changed = t0 != null && Math.abs(t0 - t) >= 5;
    return `<li class="pv__row ${mvk ? 'is-moved' : ''} pv__row--${it.type}"><span class="pv__t num">${changed ? `<s>${clock(t0)}</s>` : ''}<b>${clock(t)}</b></span>
      <span class="pv__n">${mvk === 'up' ? '<span class="mv mv--up">↑</span>' : mvk === 'down' ? '<span class="mv mv--down">↓</span>' : ''}${esc(itemLabel(it.id))}</span>
      ${it.type === 'ride' ? `<span class="pv__m">${ic('walk')}${it.walk} ${ic('clock')}${it.wait}</span>` : '<span class="pv__m"></span>'}</li>`;
  };
  openSheet(`<div class="sheet__content">
    <div class="pv__head"><span class="sugg__gain">${ic('refresh')}${sg.gain >= 1 ? `<b class="num">−${sg.gain}</b><small>分</small>` : ic('check')}</span>
      <span class="pv__stat">${ic('walk')}<s class="num">${L.walk[0]}</s>${ic('chev')}<b class="num">${L.walk[1]}</b>分</span>
      <span class="pv__stat">${ic('clock')}<s class="num">${L.wait[0]}</s>${ic('chev')}<b class="num">${L.wait[1]}</b>分</span></div>
    <ol class="pv">${L.nxt.map(row).join('')}</ol>
    <div class="btnrow"><button class="btn" data-act="suggest-off" data-close>このまま</button><button class="btn btn--primary" data-act="suggest-apply" data-close>反映</button></div>
  </div>`);
}
const planSeq = () => S.planSnap?.seq || (S.planSnap?.items ? S.planSnap.items.filter((i) => SEQ_TYPES.includes(i.type)).map((i) => i.id) : []);
// Recalculate times only — keeps the order exactly (乗った, edits, meal/show settings).
function relayout(why) { return S.planSnap?.items ? layoutPlan(planSeq(), why) : buildPlan(why); }
// The very first plan is made automatically; if it was made before any wait times arrived,
// it is made once more (quietly) with the first live data — still part of "the first plan".
const planSnapshot = () => (S.planSnap?.items ? S.planSnap : (R.firstAuto = !liveIsFresh(), buildPlan('初回')));
function planItems() {
  return planSnapshot().items
    .filter((it) => !(it.id && S.done[it.id]))
    .map((it) => (it.type === 'ride' ? { ...it, a: attractionById[it.id] } : it))
    .filter((it) => it.type !== 'ride' || it.a);
}
// Next action = the first open item of the saved plan (same on both phones).
function homeReco(c) {
  const r = recommend(c);
  // rides that are down right now are skipped here (they wait in the plan for reopening)
  const open = planItems().filter(isUpcoming(c)).filter((i) => i.type !== 'ride' || (availability(i.a, c).ok && !S.excluded[i.id]));
  const first = open[0];
  if (!first) return r;
  if (r.primary?.type === 'ride' && r.primary.reasons?.[0]?.k === 'pin') return r;
  const nx = open.find((i, k) => k > 0 && i.type !== 'ride') || open[1];
  const next = nx && { id: nx.id, title: nx.a ? nx.a.short : nx.anchor.title, start: nx.type === 'ride' ? nx.start : nx.anchor.start, claim: nx.type === 'show' ? nx.anchor.start - (nx.claimFrom ?? nx.anchor.start) : 0, pos: nx.a ? coordsOf(nx.a.id) : nx.anchor.pos, kind: nx.type, place: nx.anchor?.place, restaurant: nx.anchor?.restaurant, show: nx.anchor?.show };
  if (first.type === 'ride') {
    const lv = waitInfo(first.a);
    const walk = walkMin(c.pos, coordsOf(first.a.id));
    const wait = lv.kind !== 'est' && lv.wait != null ? lv.wait : first.wait;
    const start = Math.max(c.now, c.openMin);
    const reasons = [{ k: 'plan', t: 'プランの順番' }, ...(S.locks?.[first.id] ? [{ k: 'lock', t: '固定' }] : []), ...(isMustId(first.id) ? [{ k: 'must', t: '絶対乗る' }] : [])];
    return { ...r, next, primary: { type: 'ride', a: first.a, walk, wait, kind: lv.kind !== 'est' && lv.wait != null ? lv.kind : 'est', finish: start + walk + wait + first.a.dur, reasons }, alts: r.alts.filter((x) => x.a.id !== first.id) };
  }
  const x = first.anchor;
  const walk = walkMin(c.pos, x.pos);
  const claimFrom = x.kind === 'show' ? x.start - (x.claim || 0) : x.start;
  const leaveBy = claimFrom - walk;
  // Spare time before the next meal/show (e.g. the planned ride is paused): suggest something that
  // fits in the gap; if nothing fits, show the free-time card (snacks nearby, when to leave).
  // (rides that are not in the plan are never made the next stop — they only appear under ほかの候補)
  if (leaveBy - Math.max(c.now, c.openMin) >= 20) {
    return { ...r, next: x, leaveBy, primary: { type: 'free', minutes: Math.round(claimFrom - Math.max(c.now, c.openMin)), next: x }, alts: r.alts };
  }
  return { ...r, next, primary: { type: 'anchor', anchor: x, walk } };
}
const isMustId = (id) => !!mustMap()[id];
// Upcoming = not done yet. Rides/meals stay until checked off (even if running late); a show whose start has passed drops out.
const isUpcoming = (c) => (i) => SEQ_TYPES.includes(i.type) && !i.over && i.anchor?.late !== 'miss' && (i.type !== 'show' || c.now <= i.anchor.start + 5);

// Wait shown on the plan: the REAL current wait (LIVE / 手入力) first; the planned value at
// the scheduled time only as a secondary hint when it differs. Falls back to 推定 when there is no live data.
function planWait(it, now) {
  const w = waitInfo(it.a);
  const later = it.start - now > 30;
  if (w.kind !== 'est' && w.wait == null) {
    return `<span class="tl__wait"><span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止中')}</span></span>${later ? `<span>${clock(it.start)}頃 ${it.wait}分予想</span>` : ''}`;
  }
  if (w.kind !== 'est') {
    const diff = later && Math.abs(it.wait - w.wait) >= 10;
    return `<span class="tl__wait">${ic('clock')}いま<b class="${waitClass(w.wait)}">${w.wait}</b>分${kindTag(w.kind)}</span>${diff ? `<span>${clock(it.start)}頃 ${it.wait}分予想</span>` : ''}`;
  }
  return `<span class="tl__wait">${ic('clock')}待ち<b>${it.wait}</b>分${kindTag('est')}</span>`;
}
function liveAgeText() {
  if (R.liveStatus === 'loading') return '待ち時間を取得中';
  if (liveIsFresh()) { const a = Math.round(liveAgeMin()); return `LIVE待ち時間（${a < 1 ? 'たった今' : a + '分前'}）`; }
  return '推定の待ち時間';
}

function renderPlan() {
  const el = $('#view-plan');
  if (R.dragging) { R.pendingRender = true; return; }
  const c = ctx();
  const snap = planSnapshot();
  const items = planItems();
  const sim = {
    items, rides: items.filter((i) => i.type === 'ride' && !i.paused).length,
    missingMust: (snap.missingMust || []).filter((id) => !S.done[id]),
    waiting: (snap.waiting || []).filter((id) => !S.done[id]),
  };
  const done = doneRides();
  const conflicts = anchorConflicts(c.anchors);
  const D = { plan: S.plan, cond: S.cond, must: mustMap(), prefs: S.prefs };
  const mustIds = Object.keys(mustMap()).filter((id) => attractionById[id]);
  const h = hours();
  const flash = R.flash && Date.now() - R.flash.at < 6000 ? R.flash.ids : null;
  const busy = R.liveStatus === 'loading';
  const startAt = snap.base;
  const rp = R.replanned && Date.now() - R.replanned.at < 90e3 ? R.replanned : null;
  const moves = R.moves && Date.now() - R.moves.at < 8000 ? R.moves.map : {};
  const mv = (id) => moves[id] === 'up' ? '<span class="mv mv--up" aria-label="前へ">↑</span>' : moves[id] === 'down' ? '<span class="mv mv--down" aria-label="後ろへ">↓</span>' : moves[id] === 'new' ? `<span class="mv mv--new" aria-label="追加">${ic('plus')}</span>` : '';
  const coach = !S.seenCoach && sim.items.some((i) => i.type === 'ride');
  // 1) One-line summary, then the timeline right away — the plan itself is the first thing you see.
  const outside = outsideAnchors();
  let html = `<button class="dayrow" type="button" data-act="day-edit"><span class="dayrow__k">${esc(PARK.short)}</span><span class="dayrow__v"><b>${dateLabel()}</b> ${h.customOpen ? '入園' : '開園'}<span class="num">${clock(h.open)}</span>→${h.customClose ? '退園' : '閉園'}<span class="num">${clock(h.close)}</span></span><span class="dayrow__e">${ic('edit')}変更</span></button>
    ${outside.length ? `<div class="note">${ic('info')}<div><div class="note__t">${outside.map((x) => `${esc(x.title)}（${clock(x.start)}）`).join('・')} は退園後なので外しました</div></div></div>` : ''}
    <div class="planhead"><div class="planhead__t"><b class="num">${clock(startAt)}→${clock(h.close)}</b>
      <span>乗り物 <b class="num">${done.length + sim.rides}</b></span><span>絶対 <b class="num">${mustIds.length - sim.missingMust.length}/${mustIds.length}</b></span>
      <span class="planhead__src">${esc(liveIsFresh() ? 'LIVE' : '推定')}</span></div>
    ${S.share ? `<button class="btn btn--sm sharechip ${R.shareErr ? 'is-err' : ''}" data-act="share-open" aria-label="2人で共有中">${ic('users')}共有中</button>` : ''}
    ${R.planEdit ? `<button class="btn btn--sm btn--primary" data-act="plan-edit-done">${ic('check')}完了</button>` : `<button class="btn btn--sm" data-act="plan-edit-order">${ic('edit')}編集</button>`}
    <button class="btn btn--sm" data-act="plan-edit">${ic('sliders')}条件</button></div>`;
  if (sim.missingMust.length) html += `<div class="note note--bad">${ic('alert')}<div><div class="note__t">${sim.missingMust.map((id) => esc(attractionById[id].short)).join('・')} が入りきらない</div><div class="note__s">休止中なら再開後に最優先で案内</div></div></div>`;
  if (conflicts.length) html += `<div class="note note--bad">${ic('alert')}<div><div class="note__t">ごはんとショーの時間が重なっています</div></div></div>`;
  if (S.planTime) html += `<div class="replan__custom">${ic('clock')}<span>開始時刻を指定中</span><button class="linkbtn" data-act="plan-time-auto">現在時刻に戻す</button></div>`;
  const edit = R.planEdit;
  const rm = (id, name) => `<button class="tl__rm" data-rm="${id}" aria-label="${esc(name)} をプランから外す">${ic('x')}</button>`;
  html += suggestCard();
  const here = position();
  const hereLabel = here.src === 'gps' ? 'GPS' : here.src === 'land' ? landById[S.land]?.ja : here.src === 'last' ? (attractionById[S.lastDone?.id]?.short || doneName(S.lastDone?.id)) : here.src === 'entrance' || here.src === 'outside' ? '入口' : '？';
  html += `<ol class="tl tl--plan ${edit ? 'tl--edit' : ''} ${coach ? 'tl--coach' : ''}">
    <li class="tl__item tl__item--now ${rp ? 'is-fresh' : ''}"><span class="tl__time">${clock(startAt)}</span>
      <div class="tl__now"><button class="tl__upd ${busy ? 'is-busy' : ''}" data-act="replan" aria-label="最新の待ち時間と現在地で作り直す（${clock(snap.made ?? startAt)} 作成）">${ic('refresh')}<span class="num">${clock(snap.made ?? startAt)}</span></button>
        <button class="tl__here ${here.src === 'none' ? 'is-unset' : ''}" data-act="pick-land" aria-label="現在地：${esc(here.label)}">${ic(here.src === 'gps' ? 'locate' : 'pin')}<span>${esc(hereLabel)}</span></button></div></li>`;
  for (const it of sim.items) {
    if (it.type === 'free' && it.end - it.start < 10) continue;
    if (it.type === 'ride' && (it.paused || (c.now >= c.openMin && !availability(it.a, c).ok))) {
      // paused: stays in its place, takes no time; the next stop skips it until it reopens
      const a = it.a;
      html += `<li class="tl__item tl__item--ride tl__item--paused" data-ride="${a.id}" data-drag="${a.id}"><span class="tl__time">休止</span>
        <div class="tl__card"><span class="tl__grip" data-grip="${a.id}" role="button" aria-label="${esc(a.short)} をドラッグして順番を変更">${ic('grip')}</span>
          <button class="tl__main" data-open="${a.id}"><span class="tl__name">${jw(a.short)}${it.must ? '<span class="tag tag--must">絶対</span>' : ''}</span>
          <span class="tl__meta"><span class="tag tag--bad">一時休止中</span><span>再開したらお知らせ・このまま次へ</span></span></button>
          ${edit ? rm(a.id, a.short) : `<button class="check" data-done="${a.id}" aria-label="${esc(a.short)} 乗った">${ic('check')}</button>`}</div></li>`;
    } else if (it.type === 'ride') {
      const a = it.a;
      html += `<li class="tl__item tl__item--ride ${it.must ? 'tl__item--must' : ''} ${flash?.has(a.id) ? 'is-changed' : ''} ${it.end < c.now - 5 ? 'is-past' : ''}" data-ride="${a.id}" data-drag="${a.id}"><span class="tl__time">${clock(it.start)}${mv(a.id)}</span>
        <div class="tl__card"><span class="tl__grip" data-grip="${a.id}" role="button" aria-label="${esc(a.short)} をドラッグして順番を変更">${ic('grip')}</span>
          <button class="tl__main" data-open="${a.id}"><span class="tl__name">${jw(a.short)}${it.must ? '<span class="tag tag--must">絶対</span>' : ''}${it.over ? '<span class="tag tag--bad">閉園に間に合わない</span>' : ''}</span>
          <span class="tl__meta">${planWait(it, c.now)}<span>${ic('walk')}${it.walk}分</span><span>〜<span class="num">${clock(it.end)}</span></span></span></button>
          <button class="tl__lock ${S.locks?.[a.id] ? 'is-on' : ''}" data-lock="${a.id}" aria-pressed="${!!S.locks?.[a.id]}" aria-label="${esc(a.short)} の位置を${S.locks?.[a.id] ? '固定中（タップで解除）' : '固定'}">${ic(S.locks?.[a.id] ? 'lock' : 'unlock')}</button>
          ${edit ? rm(a.id, a.short) : `<button class="check" data-done="${a.id}" aria-label="${esc(a.short)} 乗った">${ic('check')}</button>`}</div></li>`;
    } else if (it.type === 'meal' || it.type === 'show') {
      const x = it.anchor;
      const isMeal = it.type === 'meal';
      const lateTag = x.late === 'miss' ? '<span class="tag tag--bad">間に合わない</span>' : x.late === 'short' ? '<span class="tag tag--warn">場所取り短め</span>' : '';
      html += `<li class="tl__item tl__item--${it.type} ${flash?.has(x.id) ? 'is-changed' : ''} ${x.late === 'miss' ? 'tl__item--late' : ''}" data-drag="${x.id}"><span class="tl__time">${clock(x.start)}${mv(x.id)}</span>
        <div class="tl__card"><span class="tl__grip" data-grip="${x.id}" role="button" aria-label="${esc(x.title)} をドラッグして順番を変更">${ic('grip')}</span><button class="tl__main" data-anchor-edit="${x.id}"><span class="tl__name">${jw(x.title)}${isMeal ? '' : '<span class="tag">時刻固定</span>'}${x.shifted ? '<span class="tag tag--warn">時間をずらした</span>' : ''}${lateTag}</span>
          <span class="tl__meta">${it.type === 'meal' ? `<span>${ic('food')}${esc(x.place)}</span>` : ''}<span><span class="num">${clock(x.start)}–${clock(x.end)}</span></span>${x.claim && x.late !== 'miss' ? `<span style="color:var(--red)">場所取り <span class="num">${clock(it.claimFrom ?? x.start - x.claim)}</span>〜</span>` : ''}</span></button>
          ${edit ? rm(x.id, x.title) : `<button class="check" data-done="${x.id}" aria-label="${esc(x.title)} 完了">${ic('check')}</button>`}</div></li>`;
    } else if (it.type === 'dropped') {
      html += `<li class="tl__item tl__item--dropped"><span class="tl__time">${clock(it.start)}</span>
        <div class="tl__card"><div class="tl__main"><span class="tl__name" style="text-decoration:line-through">${esc(it.anchor.title)}</span><span class="tl__meta">絶対乗るものを優先して見送り</span></div></div></li>`;
    } else {
      html += `<li class="tl__item tl__item--free"><span class="tl__time">${clock(it.start)}</span><div class="tl__card">自由時間 ${fmtDur(it.end - it.start)}</div></li>`;
    }
  }
  html += `</ol><button class="btn btn--block addbtn" data-act="plan-add">${ic('plus')}乗り物・ごはん・ショーを追加</button>`;

  // 2) Below the plan: re-plan options and the conditions summary.
  html += `<div class="sec"><h2><span class="sec__en">REPLAN</span>作り直す</h2></div>
    <div class="card replan">
      <button class="btn btn--navy btn--block ${busy ? 'is-busy' : ''}" data-act="replan" ${busy ? 'disabled' : ''}>${ic('refresh')}今から作り直す</button>
      <div class="replan__time">
        <label for="planTimeInput"><b>別の時刻から</b></label>
        <div class="plan-start__row"><input type="time" id="planTimeInput" value="${clock(startAt)}" aria-label="プランの開始時刻">
          <button class="btn btn--sm btn--navy" data-act="plan-time-set">この時刻から作る</button></div>
      </div>
    </div>
    <div class="card condsum">
    <dl class="kv condsum__kv">${condSummary(D).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <button class="btn btn--navy btn--block" data-act="plan-edit">${ic('sliders')}条件を変えてプランを作る</button></div>
    <div class="card sharecard"><div class="sharecard__t">${ic('users')}<div><b>${S.share ? '2人で共有中' : '2人で同じプランを使う'}</b>
      <small>${S.share ? esc(shareStatus()) : '片方が「乗った」や順番を変えると、もう1台も自動で更新'}</small></div></div>
      <button class="btn btn--sm ${S.share ? '' : 'btn--navy'}" data-act="share-open">${S.share ? '管理' : '始める'}</button></div>`;

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
  if (coach) { S.seenCoach = true; save(); }
}
const planRideIds = () => planItems().filter((i) => i.type === 'ride').map((i) => i.id);

// One fresh GPS fix (if GPS is on), at most `ms` long — the plan is built from where you really are.
function freshFix(ms = 4000) {
  if (!S.gps || !('geolocation' in navigator)) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    navigator.geolocation.getCurrentPosition((p) => {
      clearTimeout(t);
      R.gpsPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      R.gpsRendered = R.gpsPos; R.gpsRenderedAt = R.gpsPos.at;
      done();
    }, () => { clearTimeout(t); done(); }, { enableHighAccuracy: true, maximumAge: 20e3, timeout: ms });
  });
}
// Re-plan: latest waits + current position, drop any manual order; changes are shown as ↑↓ on the rows.
async function replan() {
  await Promise.all([fetchLive({ manual: false }), freshFix()]);
  proposeRebuild('今から作り直す', () => { S.order = null; });
}

// ---------- rebuild proposals: a full rebuild never changes the plan until you tap 反映 ----------
const PROPOSE_FIELDS = ['plan', 'cond', 'must', 'excluded', 'order', 'prefs', 'planTime', 'sim', 'cfg', 'planSnap', 'locks'];
const pickFields = () => Object.fromEntries(PROPOSE_FIELDS.map((k) => [k, structuredClone(S[k] ?? null)]));
function proposeRebuild(why, mutate) {
  const hadPlan = !!S.planSnap?.items;
  const before = pickFields();
  noSave = hadPlan;
  const date0 = tripDate();
  try { mutate?.(); buildPlan(why); } finally { noSave = false; }
  if (!hadPlan) afterDateChange(date0);
  if (!hadPlan) { save(); renderAll(); return; }
  const after = pickFields();
  Object.assign(S, structuredClone(before)); // nothing changes until 反映
  R.proposal = { why, before, after };
  const diff = proposalDiff(R.proposal);
  if (!diff.changed) {
    const date0 = tripDate();
    Object.assign(S, structuredClone(after)); afterDateChange(date0); save(); R.proposal = null; renderAll();
    return toast(`${why}：今のプランのままで最適です`, 'ok');
  }
  renderAll();
  openProposal();
}
function proposalDiff(pr) {
  const open = (snap) => (snap?.items || []).filter((i) => i.id && !S.done[i.id] && SEQ_TYPES.includes(i.type));
  const b = open(pr.before.planSnap), a = open(pr.after.planSnap);
  const rides = (l) => l.filter((i) => i.type === 'ride' && !i.paused).map((i) => i.id);
  const br = rides(b), ar = rides(a);
  const added = ar.filter((id) => !br.includes(id)), removed = br.filter((id) => !ar.includes(id));
  const startOf = Object.fromEntries(b.map((i) => [i.id, i.type === 'ride' ? i.start : i.anchor?.start ?? i.start]));
  const meals = a.filter((i) => i.type === 'meal' && startOf[i.id] != null && Math.abs(startOf[i.id] - i.start) >= 5).map((i) => ({ id: i.id, from: startOf[i.id], to: i.start }));
  const keep = br.filter((id) => ar.includes(id)), keepA = ar.filter((id) => br.includes(id));
  const reordered = keep.join() !== keepA.join();
  const sum = (l, k) => l.filter((i) => i.type === 'ride' && !i.paused).reduce((t, i) => t + (i[k] || 0), 0);
  return { b, a, added, removed, meals, reordered, startOf, rides: [br.length, ar.length], wait: [sum(b, 'wait'), sum(a, 'wait')], walk: [sum(b, 'walk'), sum(a, 'walk')],
    changed: added.length || removed.length || meals.length || reordered || JSON.stringify(pr.before.planSnap?.seq) !== JSON.stringify(pr.after.planSnap?.seq) };
}
function openProposal() {
  const pr = R.proposal; if (!pr) return;
  const d = proposalDiff(pr);
  const keep = d.b.map((i) => i.id);
  const label = (id) => itemLabel(id);
  const row = (it, k) => {
    const j = keep.indexOf(it.id);
    const mvk = j < 0 ? 'new' : j > k ? 'up' : k - j >= 2 ? 'down' : '';
    const t = it.type === 'ride' ? it.start : it.anchor.start;
    const t0 = d.startOf[it.id];
    const moved = t0 != null && Math.abs(t0 - t) >= 5;
    return `<li class="pv__row ${mvk ? 'is-moved' : ''} pv__row--${it.type}"><span class="pv__t num">${moved ? `<s>${clock(t0)}</s>` : ''}<b>${clock(t)}</b></span>
      <span class="pv__n">${mvk === 'new' ? `<span class="mv mv--new">${ic('plus')}</span>` : mvk === 'up' ? '<span class="mv mv--up">↑</span>' : mvk === 'down' ? '<span class="mv mv--down">↓</span>' : ''}${esc(label(it.id))}${it.paused ? '<span class="tag tag--bad">休止中</span>' : ''}</span>
      ${it.type === 'ride' && !it.paused ? `<span class="pv__m">${ic('clock')}${it.wait}</span>` : '<span class="pv__m"></span>'}</li>`;
  };
  const chips = (ids, cls) => ids.map((id) => `<span class="chipx ${cls}">${esc(label(id))}</span>`).join('');
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">${esc(pr.why)}</div><h2 class="sheet__title" id="sheetTitle">作り直し案</h2>
      <p class="muted" style="font-size:13px;margin:4px 0 0">「反映」を押すまで、今のプランは変わりません</p></div>
    <div class="pv__head">
      <span class="pv__stat">乗り物 <s class="num">${d.rides[0]}</s>${ic('chev')}<b class="num">${d.rides[1]}</b></span>
      <span class="pv__stat">${ic('clock')}<s class="num">${d.wait[0]}</s>${ic('chev')}<b class="num">${d.wait[1]}</b>分</span>
      <span class="pv__stat">${ic('walk')}<s class="num">${d.walk[0]}</s>${ic('chev')}<b class="num">${d.walk[1]}</b>分</span></div>
    ${d.added.length ? `<div class="pdiff"><b>追加</b><div>${chips(d.added, 'is-add')}</div></div>` : ''}
    ${d.removed.length ? `<div class="pdiff"><b>外す</b><div>${chips(d.removed, 'is-rm')}</div></div>` : ''}
    ${d.meals.length ? `<div class="pdiff"><b>ごはん</b><div>${d.meals.map((m) => `<span class="chipx">${esc(label(m.id))} <s class="num">${clock(m.from)}</s>→<b class="num">${clock(m.to)}</b></span>`).join('')}</div></div>` : ''}
    ${d.reordered ? `<div class="pdiff"><b>順番</b><div><span class="chipx">↑↓ の乗り物の順番が変わります</span></div></div>` : ''}
    <ol class="pv">${d.a.map(row).join('')}</ol>
    <div class="btnrow"><button class="btn" data-act="proposal-cancel">やめる</button><button class="btn btn--primary" data-act="proposal-apply">反映</button></div>
  </div>`);
}
function applyProposal() {
  const pr = R.proposal; if (!pr) return;
  const before = planSeq();
  const date0 = tripDate();
  Object.assign(S, structuredClone(pr.after));
  afterDateChange(date0);
  R.proposal = null; R.suggest = null;
  save(); closeSheet();
  markMoves(before, planSeq());
  R.replanned = { at: Date.now() };
  if (S.tab !== 'plan') go('plan'); else renderAll();
  toast(`${pr.why}：反映しました`, 'ok');
}
function cancelProposal() {
  R.proposal = null; closeSheet(); renderAll();
  toast('今のプランのままです');
}

// ---------- drag & drop reordering (touch + mouse, pointer events) ----------
let drag = null;
function dragRows() { return [...document.querySelectorAll('#view-plan .tl--plan > li[data-drag]')]; }
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest?.('[data-grip]');
  if (!g || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const li = g.closest('li[data-drag]');
  const rows = dragRows();
  if (!li || rows.length < 2) return;
  e.preventDefault();
  const sy = scrollY;
  const boxes = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top + sy, bottom: b.bottom + sy, mid: b.top + sy + b.height / 2 }; });
  const ol = li.parentElement;
  const mark = document.createElement('div');
  mark.className = 'tl__drop';
  ol.appendChild(mark);
  drag = { li, id: li.dataset.drag, rows, boxes, from: rows.indexOf(li), to: rows.indexOf(li), y0: e.clientY + sy, cy: e.clientY, pid: e.pointerId, ol, mark, dir: 0, raf: 0 };
  try { g.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  R.dragging = true;
  li.classList.add('is-dragging');
  document.body.classList.add('is-dragging');
  try { navigator.vibrate?.(12); } catch { /* iOS */ }
  dragUpdate();
});
function dragUpdate() {
  const d = drag;
  if (!d) return;
  const y = d.cy + scrollY, dy = y - d.y0;
  d.li.style.transform = `translateY(${dy}px)`;
  const center = d.boxes[d.from].mid + dy;
  const others = d.boxes.filter((_, i) => i !== d.from);
  let to = 0;
  for (const b of others) if (b.mid < center) to++;
  d.to = to;
  // drop indicator between rows (in the list's own coordinates)
  const olTop = d.ol.getBoundingClientRect().top + scrollY;
  const at = to < others.length ? others[to].top - 4 : others[others.length - 1].bottom + 4;
  d.mark.style.top = `${at - olTop - 1.5}px`;
  d.mark.hidden = to === d.from;
}
function dragScroll() {
  if (!drag || !drag.dir) { if (drag) drag.raf = 0; return; }
  scrollBy(0, drag.dir * 7);
  dragUpdate();
  drag.raf = requestAnimationFrame(dragScroll);
}
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  e.preventDefault();
  drag.cy = e.clientY;
  const topEdge = ($('.topbar')?.offsetHeight || 45) + 40, bottomEdge = innerHeight - (($('.tabbar')?.offsetHeight || 60) + 40);
  drag.dir = e.clientY < topEdge ? -1 : e.clientY > bottomEdge ? 1 : 0;
  if (drag.dir && !drag.raf) drag.raf = requestAnimationFrame(dragScroll);
  dragUpdate();
}, { passive: false });
function dragEnd(e) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  d.mark.remove();
  d.li.classList.remove('is-dragging');
  d.li.style.transform = '';
  document.body.classList.remove('is-dragging');
  R.dragging = false;
  if (R.pausedPending) { R.pausedPending = false; setTimeout(() => { syncPaused(); renderAll(); }, 0); }
  const ids = d.rows.map((r) => r.dataset.drag);
  if (e?.type === 'pointerup' && d.to !== d.from) {
    const rest = ids.filter((id) => id !== d.id);
    rest.splice(d.to, 0, d.id);
    return setOrder(rest, d.id);
  }
  if (R.pendingRender) { R.pendingRender = false; renderView(); }
}
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);
// iOS: stop the page from scrolling while a row is being dragged
document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

// ids: the new order of the draggable rows (rides, meals, shows). The order is kept exactly;
// a moved meal starts where it now sits, shows keep their fixed time (late → warning only).
function setOrder(ids, movedId) {
  const prev = { seq: planSeq(), prefs: structuredClone(S.prefs) };
  const done = prev.seq.filter((x) => S.done[x]);
  const rest = prev.seq.filter((x) => !S.done[x] && !ids.includes(x)); // e.g. waiting rides
  if (movedId.startsWith('meal:')) {
    // let the meal start on arrival at its new place, then remember that time
    const m = movedId.slice(5);
    S.prefs.mealOverrides[m] = { ...(S.prefs.mealOverrides[m] || {}), at: 0 };
    layoutPlan([...done, ...ids, ...rest], '並べ替え');
    const it = S.planSnap.items.find((x) => x.id === movedId);
    S.prefs.mealOverrides[m].at = it ? Math.round(it.start) : mealCfg(m).base.at;
  }
  layoutPlan([...done, ...ids, ...rest], '並べ替え');
  R.pendingRender = false;
  R.flash = { at: Date.now(), ids: new Set([movedId]) };
  renderView();
  const undo = { label: '元に戻す', fn: () => { S.prefs = prev.prefs; layoutPlan(prev.seq, '並べ替え'); renderAll(); } };
  const it = S.planSnap.items.find((x) => x.id === movedId);
  const late = (S.planSnap.late || []).filter((x) => !S.done[x]);
  if (late.length) return toast(`この順番だと ${late.map(itemLabel).join('・')} に間に合いません`, 'warn', undo);
  if (movedId.startsWith('meal:') && it) return toast(`${doneName(movedId)} を ${clock(it.start)} にしました`, 'ok', undo);
  toast(`${itemLabel(movedId)} の順番を変更しました`, 'ok', undo);
}

// ---------- free editing: add / remove ----------
const itemLabel = (id) => attractionById[id]?.short || (id.startsWith('meal:') ? (PLANS[S.plan].meals.find((m) => 'meal:' + m.id === id)?.ja || 'ごはん') : showById[id.slice(5)]?.short || id);
function editSnapshot() { return { seq: planSeq(), excluded: { ...S.excluded }, must: S.must, locks: { ...S.locks }, prefs: structuredClone(S.prefs) }; }
function restoreEdit(sn) { S.excluded = sn.excluded; S.must = sn.must; S.locks = sn.locks; S.prefs = sn.prefs; layoutPlan(sn.seq, '並べ替え'); renderAll(); }
// Insert where the day flows best: try every slot of the sequence and keep the one that makes
// nothing late and ends earliest (locked rides and the rest keep their order).
function bestSlot(seq, id) {
  const c = ctx({ order: null, orderReason: null });
  const open = seq.filter((x) => !S.done[x]);
  let best = null;
  for (let i = 0; i <= open.length; i++) {
    const o = [...open.slice(0, i), id, ...open.slice(i)];
    const cost = planCost(c, [...seq.filter((x) => S.done[x]), ...o]);
    if (!best || cost < best.cost) best = { cost, o };
  }
  return [...seq.filter((x) => S.done[x]), ...best.o];
}
function addToPlan(id, mode = 'best') {
  const sn = editSnapshot();
  const seq = planSeq().filter((x) => x !== id);
  if (attractionById[id]) delete S.excluded[id];
  else if (id.startsWith('meal:')) { const m = id.slice(5); S.prefs.mealOverrides[m] = { ...(S.prefs.mealOverrides[m] || {}), off: false }; }
  else if (id.startsWith('show:')) { const x = id.slice(5); S.prefs.shows[x] = { ...(S.prefs.shows[x] || {}), on: true }; }
  if (S.planSnap?.dropped) S.planSnap.dropped = S.planSnap.dropped.filter((x) => x !== id);
  let nseq;
  if (mode === 'next') nseq = [...seq.filter((x) => S.done[x]), id, ...seq.filter((x) => !S.done[x])];
  else if (attractionById[id]) nseq = bestSlot(seq, id);
  else nseq = seq; // meals/shows are placed by their time (syncSequence)
  layoutPlan(nseq, '追加');
  R.flash = { at: Date.now(), ids: new Set([id]) };
  renderAll();
  const it = planItems().find((x) => x.id === id);
  const msg = !it ? `${itemLabel(id)} は今は休止中のため「再開待ち」に入れました`
    : mode === 'next' ? `${itemLabel(id)} を次の行き先にしました`
    : `${itemLabel(id)} を ${clock(it.type === 'ride' ? it.start : it.anchor.start)} に追加しました`;
  toast(msg, 'ok', { label: '元に戻す', fn: () => restoreEdit(sn) });
}
function removeFromPlan(id) {
  const sn = editSnapshot();
  if (attractionById[id]) {
    S.excluded = { ...S.excluded, [id]: true };
    if (S.must?.[id]) { S.must = { ...S.must }; delete S.must[id]; }
    if (S.locks?.[id]) { S.locks = { ...S.locks }; delete S.locks[id]; }
  } else if (id.startsWith('meal:')) {
    const m = id.slice(5); S.prefs.mealOverrides[m] = { ...(S.prefs.mealOverrides[m] || {}), off: true };
  } else if (id.startsWith('show:')) {
    const x = id.slice(5); S.prefs.shows[x] = { ...(S.prefs.shows[x] || {}), on: false };
  }
  layoutPlan(planSeq().filter((x) => x !== id), '削除'); renderAll();
  toast(`${itemLabel(id)} をプランから外しました`, '', { label: '元に戻す', fn: () => restoreEdit(sn) });
}
function openAddSheet() {
  const c = ctx();
  const inPlan = new Set(planItems().map((i) => i.id).filter(Boolean));
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
      return `<button class="row" type="button" data-add="meal:${m.id}"><span class="row__body"><span class="row__k">ごはん · <span class="num">${clock(mc.at)}</span></span><span class="row__name">${esc(m.ja)}</span><span class="row__meta">${ic('food')}${esc(restaurantById[mc.rest]?.ja || '')} · ${mc.dur}分</span></span><span class="row__chev">${ic('plus')}</span></button>`;
    }).join('')}${shows.map((x) => `<button class="row" type="button" data-add="show:${x.id}"><span class="row__body"><span class="row__k">ショー</span><span class="row__name">${jw(x.short)}</span><span class="row__meta">${ic('clock')}${showTimesFor(x.id).times.join(' / ')}</span></span><span class="row__chev">${ic('plus')}</span></button>`).join('')}</div>` : ''}
    <div class="card rows">${rides.map((a) => {
      const w = waitInfo(a);
      return `<button class="row" type="button" data-add="${a.id}"><span class="row__thumb">${rideImg(a)}</span>
        <span class="row__body"><span class="row__k">${esc(landById[a.land]?.ja || '')}${S.excluded[a.id] ? ' · 乗らない設定' : ''}</span><span class="row__name">${jw(a.short)}</span><span class="row__meta">${ic('walk')}${walkMin(c.pos, coordsOf(a.id))}分</span></span>
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
  return ctx({ planId: D.plan, cond: D.cond, must: D.must, excluded: D.excluded, anchors: anchorsD, now: D.startMode === 'custom' ? D.startMin : nowMin(), order: D.first ? [D.first] : null, orderReason: null });
}
function openPlanBuilder(focus) {
  if (!R.draft) R.draft = structuredClone({ plan: S.plan, cond: S.cond, must: mustMap(), excluded: S.excluded, prefs: { ...S.prefs, showTimes: undefined }, startMode: S.planTime ? 'custom' : 'auto', startMin: Math.floor(nowMin()), first: '' });
  const D = R.draft;
  const sim = simulateDay(draftCtx(D));
  const mustIds = Object.keys(D.must);
  const opt = (key, val, label, sub) => `<button class="opt ${String(key === 'plan' ? D.plan : D.cond[key]) === String(val) ? 'is-active' : ''}" data-b-set="${key}" data-v="${val}"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
  const rides = [...ATTRACTIONS].sort((a, b) => b.pop - a.pop || (PRIORITY[b.id] || 0) - (PRIORITY[a.id] || 0));
  const showOn = (id) => D.prefs.shows[id]?.on ?? PLANS[D.plan].shows[id];
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Plan builder</div><h2 class="sheet__title" id="sheetTitle">プランの条件</h2></div>
    <div class="form">
      <div class="field"><div class="field__h"><b>開始時刻</b><span>途中からでもOK</span></div>
        <div class="plan-start__row"><input type="time" data-b-start value="${clock(D.startMode === 'custom' ? D.startMin : nowMin())}" aria-label="プランの開始時刻">
          <button class="btn btn--sm btn--navy" data-act="b-start-now">実際の現在時刻を使う</button></div>
        <div class="plan-start__hint">${D.startMode === 'custom' ? '入力した時刻から計画' : '現在時刻から計画'} · 完了済みの記録は保持</div>
      </div>
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
          const groups = shopGroups(m.id === 'snack' ? 'sweets' : 'meal');
          return `<div class="mealrow"><div class="mealrow__h"><b>${MEAL_JA[m.id]}</b><span class="toggle"><input type="checkbox" data-b-meal-on="${m.id}" ${on ? 'checked' : ''} aria-label="${MEAL_JA[m.id]}"><i></i></span></div>
            ${on ? `<div class="mealrow__ctl">
              <select data-b-meal-rest="${m.id}" aria-label="${MEAL_JA[m.id]}のお店">${groups.map((g) => `<optgroup label="${g.label}">${g.list.map(({ r }) => `<option value="${r.id}" ${r.id === rest ? 'selected' : ''}>${esc(r.ja)}</option>`).join('')}</optgroup>`).join('')}</select>
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
    <div class="sheet__foot"><button class="btn btn--primary btn--block" data-act="plan-apply">この条件でプランを作る<span class="num" style="font-weight:500;margin-left:6px">乗り物 ${doneRides().length + sim.rides} · 絶対 ${mustIds.length - sim.missingMust.length}/${mustIds.length}</span></button></div>`,
  { keepScroll: true });
  if (focus) { const f = $('#b-' + focus); if (f) $('.sheet__panel').scrollTop = f.offsetTop - 30; }
}
function applyPlanDraft() {
  const D = R.draft;
  if (!D) return;
  S.plan = D.plan; S.cond = D.cond; S.must = D.must; S.excluded = D.excluded; S.order = D.first ? [D.first] : null;
  if (D.first) delete S.excluded[D.first];
  S.prefs = { ...S.prefs, mealOverrides: D.prefs.mealOverrides, shows: D.prefs.shows };
  S.planTime = D.startMode === 'custom' ? { base: D.startMin, setAt: Date.now() } : null;
  if (D.startMode === 'custom') S.sim = null;
  for (const id of Object.keys(S.must)) delete S.excluded[id];
}
function applyPlanDraftProposal() {
  const D = R.draft;
  if (!D) return;
  closeSheet();
  R.draft = D;
  proposeRebuild('条件を変更', () => applyPlanDraft());
  R.draft = null;
}

// =====================================================================
// EXPLORE (rides / food / shows / halloween)
// =====================================================================
function renderExplore() {
  const el = $('#view-explore');
  const tab = S.exploreTab;
  const xtabs = [['rides', '乗り物'], ['food', '食事'], ['shows', 'ショー'], ...(PARK.limitedTab ? [['halloween', PARK.limitedTab]] : [])];
  if (!xtabs.some(([k]) => k === tab)) { S.exploreTab = 'rides'; return renderExplore(); }
  let html = `<div class="seg" role="tablist">${xtabs.map(([k, n]) => `<button class="${tab === k ? 'is-active' : ''}" data-xtab="${k}" role="tab" aria-selected="${tab === k}">${n}</button>`).join('')}</div>`;
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
    const q = S.foodQ || '';
    html += `<label class="fsearch">${ic('search')}<input id="foodQ" type="search" enterkeyhint="search" autocomplete="off" placeholder="食べたいもの（例：チキン、アイス、コーヒー）" value="${esc(q)}" aria-label="食べたいもので探す">${q ? `<button type="button" data-fq="" aria-label="消す">${ic('x')}</button>` : ''}</label>`;
    html += `<div class="chips">${FOOD_SUGGEST.map((w) => `<button class="chip ${q === w ? 'is-active' : ''}" data-fq="${w}">${w}</button>`).join('')}</div>`;
    const filters = [['all', 'すべて'], ['meal', '食事'], ['sweets', 'スイーツ'], ['snack', '軽食'], ['mobile', 'モバイルオーダー'], ...(PARK.limitedTab ? [['halloween', '限定あり']] : [])];
    html += `<div class="chips">${filters.map(([k, n]) => `<button class="chip ${S.foodFilter === k ? 'is-active' : ''}" data-ff="${k}">${n}</button>`).join('')}</div>`;
    html += `<div id="foodList">${foodListHtml(c)}</div>`;
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
      html += `<div class="sec"><h2>その他のショー</h2></div><div class="card card--pad" style="font-size:13.5px;line-height:1.9">${others.slice(0, 12).map((o) => `<div><b>${esc(o.name)}</b> <span class="num">${o.times.filter((t) => !t.date || t.date === tripDate()).map((t) => hhmm(t.start)).join(' / ') || '—'}</span></div>`).join('')}</div>`;
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

// ---------- food search: "what do I want to eat" → shops nearest to me first ----------
const FOOD_SUGGEST = ['チキン', 'アイス', '甘いもの', 'コーヒー', 'スープ', 'ミッキー型', 'ポップコーン', 'お酒', '軽食'];
const FOOD_SYN = {
  アイス: ['アイス', 'サンデー', 'ソフト', 'ホイップ', 'sundae', 'whip', 'icecream'],
  ソフトクリーム: ['ソフト', 'ホイップ', 'whip'],
  甘いもの: ['kind:sweets', 'ケーキ', 'カップケーキ', 'マカロン', 'ベニエ', 'サンデー', 'チョコ', 'パイ'], スイーツ: ['kind:sweets', 'ケーキ', 'ベニエ', 'サンデー'], デザート: ['kind:sweets', 'ケーキ', 'サンデー'],
  コーヒー: ['kind:cafe', 'coffee', 'カフェ', 'ラテ'], カフェ: ['kind:cafe', 'カフェ'],
  ドリンク: ['ドリンク', 'drink', 'カクテル', 'マティーニ', 'kind:cafe'], お酒: ['アルコール', 'マティーニ', 'カクテル', 'ビール', 'beer', 'martini'],
  パン: ['ベーカリー', 'bakery', 'トースト', 'ブレッド', 'ビスケット', 'サンド'],
  ミッキー型: ['ミッキー', 'mickey'], ミッキー: ['ミッキー', 'mickey'],
  チキン: ['チキン', 'chicken'], 肉: ['チキン', 'ビーフ', 'ポーク', '串', 'bbq', 'バーベキュー', 'ラップ', 'バーガー', 'burger'],
  ごはん: ['kind:meal'], ご飯: ['kind:meal'], 食事: ['kind:meal'], がっつり: ['kind:meal'],
  軽食: ['kind:snack', 'コーンドッグ', 'ラップ', '串'], スナック: ['kind:snack'],
  スープ: ['スープ', 'チャウダー', 'ガンボ', 'soup', 'chowder', 'gumbo'],
  ハロウィン: ['halloween'], 限定: ['halloween'], ベジ: ['ベジ', 'veg', 'グリーン'],
};
const fnorm = (t) => String(t || '').toLowerCase().normalize('NFKC').replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)).replace(/[\s・･\-ー’'.&]/g, '');
const KIND_TAG = { meal: 'kind:meal', cafe: 'kind:cafe kind:meal', sweets: 'kind:sweets', snack: 'kind:snack' };
const foodIndex = new Map(RESTAURANTS.map((r) => [r.id, {
  all: fnorm([r.ja, r.en, r.style, r.desc, ...r.menu.flatMap((m) => [m.name, m.en]), ...r.halloween.flatMap((h) => [h.name, h.en])].join(' ')) + ' ' + (KIND_TAG[r.kind] || '') + (r.halloween.length ? ' halloween' : ''),
  items: [...r.menu.map((m) => ({ ...m, h: false })), ...r.halloween.map((h) => ({ name: h.name, en: h.en, price: '限定', h: true }))].map((m) => ({ ...m, key: fnorm(m.name + ' ' + m.en) })),
}]));
function foodTerms(q) {
  return String(q || '').split(/[\s　、,]+/).filter(Boolean).map((t) => {
    const syn = FOOD_SYN[t] || FOOD_SYN[t.replace(/[がをのも]$/, '')] || [];
    return [...new Set([fnorm(t), ...syn.map((x) => (x.startsWith('kind:') ? x : fnorm(x)))])].filter(Boolean);
  });
}
function foodSearch(q, pos) {
  const terms = foodTerms(q);
  const f = S.foodFilter;
  const out = [];
  for (const r of RESTAURANTS) {
    if (!(f === 'all' || (f === 'meal' && (r.kind === 'meal' || r.kind === 'cafe')) || (f === 'sweets' && (r.kind === 'sweets' || r.kind === 'cafe')) || (f === 'snack' && r.kind === 'snack') || (f === 'mobile' && r.mobile === 'yes') || (f === 'halloween' && r.halloween.length))) continue;
    const ix = foodIndex.get(r.id);
    if (terms.length && !terms.every((alts) => alts.some((a) => ix.all.includes(a)))) continue;
    const hits = terms.length ? ix.items.filter((m) => terms.some((alts) => alts.some((a) => !a.startsWith('kind:') && m.key.includes(a)))) : [];
    const p = coordsOf(r.id);
    out.push({ r, hits, walk: walkMin(pos, p), d: pos ? distanceM(pos, p) : null });
  }
  out.sort((x, y) => (x.d ?? 1e9) - (y.d ?? 1e9) || (y.hits.length - x.hits.length));
  return out;
}
const markHit = (text, q) => {
  let h = esc(text);
  for (const t of String(q || '').split(/[\s　、,]+/).filter((x) => x.length >= 2)) h = h.split(esc(t)).join(`<mark>${esc(t)}</mark>`);
  return h;
};
function foodListHtml(c) {
  const q = (S.foodQ || '').trim();
  const pos = position();
  const list = foodSearch(q, c.pos);
  R.foodHits = q ? list.map((x) => x.r.id) : null;
  const where = pos.src === 'gps' ? '現在地（GPS）から近い順' : pos.src === 'none' ? '現在地が未設定のため距離は目安' : `${pos.src === 'land' ? landById[S.land]?.ja : '推定の現在地'}から近い順`;
  let html = `<div class="fbar"><span>${q ? `「${esc(q)}」${list.length}件 · ` : ''}${esc(where)}</span><span style="display:flex;gap:6px">${pos.src === 'gps' ? '' : `<button class="btn btn--sm btn--navy" data-act="gps-start">${ic('locate')}現在地</button>`}${q && list.length ? `<button class="btn btn--sm" data-act="food-map">${ic('pin')}マップ</button>` : ''}</span></div>`;
  if (q && /ポップコーン|ﾎﾟｯﾌﾟｺｰﾝ|popcorn|ポップコン/i.test(q)) {
    html += `<div class="card rows">${POPCORN.map((p) => `<div class="row"><span class="row__body"><span class="row__name">${jw(p.ja)}</span><span class="row__meta"><span class="num">${esc(p.price)}</span></span><span class="row__meta">${esc(p.where)}</span></span></div>`).join('')}</div>`;
  }
  if (!list.length) {
    return html + `<div class="card card--pad empty">「${esc(q)}」はこのアプリの店データに見つかりませんでした。<br>ワゴン販売（チュロス・ポップコーンなど）は園内各所にあります。公式アプリのメニュー検索も試してください。</div>`;
  }
  html += `<div class="card rows">${list.map(({ r, hits, walk }) => `
    <button class="row" data-open-food="${r.id}" type="button">
      <span class="row__thumb">${foodImg(r)}</span>
      <span class="row__body"><span class="row__name">${jw(r.ja)}</span>
        ${hits.length ? `<span class="fhits">${hits.slice(0, 3).map((m) => `<span class="fhit"><span>${markHit(m.name, q)}</span><span>${esc(String(m.price).replace(/（[^）]*）/g, ''))}</span></span>`).join('')}</span>` : `<span class="row__meta"><span>${esc(r.menu[0]?.name || '')}</span></span>`}
        <span class="row__meta"><span>${ic('walk')}徒歩${walk}分</span><span>${esc(landById[r.land]?.ja || '')}</span>${r.mobile === 'yes' ? '<span class="tag tag--live">モバイルオーダー</span>' : ''}${r.halloween.length ? '<span class="tag tag--warn">限定</span>' : ''}</span></span>
      <span class="row__chev">${ic('chev')}</span></button>`).join('')}</div>
    <p class="footer">料金・限定メニューは事前調査の情報です</p>`;
  return html;
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
        <a class="btn" ${routeAttr(pos)}>${ic('route')}ルート</a>
      </div>
      ${S.done[a.id] ? '' : `<div class="btnrow">${planRideIds().includes(a.id) ? `<span class="muted inplan">${ic('check')}プランに入っています</span>` : `<button class="btn" data-add="${a.id}" data-add-how="best" data-close>${ic('plus')}プランに追加</button>`}<button class="btn" data-add="${a.id}" data-add-how="next" data-close>${ic('flag')}次に行く</button></div>`}
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
      <ul class="menu menu--dish">${r.menu.map((m, i) => { const p = R.photos?.[`menu_${r.id}_${i}`]; return `<li>${dishImg(r, i)}<span class="dish__b"><b>${esc(m.name)}</b><small class="muted">${esc(m.en)}</small>${p?.src ? `<a class="dish__cr" href="${esc(p.page)}" target="_blank" rel="noopener">${esc([p.author, p.license].filter(Boolean).join(' · ') || 'Wikimedia Commons')}</a>` : ''}</span><span class="dish__p">${esc(m.price)}</span></li>`; }).join('')}</ul>
      ${r.halloween.length ? `<div class="box"><b>ハロウィン限定（報道ベース）</b>${r.halloween.map((h) => `${esc(h.name)}<span class="muted">（${esc(h.note)}）</span>`).join('<br>')}</div>` : ''}
      <div class="btnrow">
        <a class="btn" ${routeAttr(pos)}>${ic('route')}ルート</a>
        <button class="btn" data-food-map="${r.id}">${ic('pin')}地図で見る</button>
      </div>
      <div class="btnrow">
        <a class="btn btn--navy" href="${esc(r.menuUrl)}" target="_blank" rel="noopener">${ic('food')}公式メニュー（写真・価格）</a>
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
  const c = ctx();
  const groups = shopGroups(mealId === 'snack' ? 'sweets' : 'meal', c.pos);
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Meal</div><h2 class="sheet__title" id="sheetTitle">${esc(base.ja)}</h2></div>
    <div class="stepper">
      <button data-meal-step="${mealId}" data-delta="-15">−15分</button>
      <div class="stepper__v">${clock(at)}<div style="font-family:var(--jp);font-size:12px;font-weight:700;color:var(--muted)">〜${clock(at + dur)}</div></div>
      <button data-meal-step="${mealId}" data-delta="15">＋15分</button>
    </div>
    <div class="field__h" style="margin:0"><b>食事にかける時間</b><span class="num">${dur}分</span></div>
    <div class="times" style="margin-top:0">${[20, 30, 45, 60, 75, 90, 120].map((t) => `<button class="time ${t === dur ? 'is-active' : ''}" data-meal-dur="${mealId}" data-v="${t}">${t}分</button>`).join('')}</div>
    <button class="btn btn--sm restcur" data-open-food="${rest}">${restaurantById[rest] ? dishImg(restaurantById[rest], 0) : ''}<span>${esc(restaurantById[rest]?.ja || '')}</span>${ic('chev')}</button>
    ${groups.map((g) => `<div class="restgrp"><div class="restgrp__h">${g.label}</div><div class="restgrid">${g.list.map(({ r, walk }) => `<button class="rest ${r.id === rest ? 'is-active' : ''}" data-meal-rest="${mealId}" data-rest="${r.id}">
      <span class="rest__n">${jw(r.ja)}</span><span class="rest__s">${ic('walk')}${walk}分${r.mobile === 'yes' ? ' · MO' : ''}</span></button>`).join('')}</div></div>`).join('')}
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
      <div class="setrow"><span class="setrow__ico">${ic('clock')}</span><div class="setrow__b"><div class="setrow__t">${esc(PARK.short)}の日程</div><div class="setrow__s">${dateLabel()} · <span class="num">${clock(h.open)}–${clock(h.close)}</span></div></div>
        <button class="btn btn--sm" data-act="day-edit">変更</button></div>
      <div class="setrow"><span class="setrow__ico">${ic('locate')}</span><div class="setrow__b"><div class="setrow__t">現在地（GPS）</div><div class="setrow__s">${S.gps && R.gpsPos ? `使用中 · 精度 約${Math.round(R.gpsPos.acc)}m` : 'オフ'}</div></div>
        <span class="toggle"><input type="checkbox" data-gps-toggle ${S.gps ? 'checked' : ''} aria-label="現在地を使う"><i></i></span></div>
      ${renderLocRow(position())}
      <div class="setrow"><span class="setrow__ico">${ic('refresh')}</span><div class="setrow__b"><div class="setrow__t">待ち時間</div><div class="setrow__s">${liveTxt}</div></div>
        <button class="btn btn--sm" data-act="refresh">更新</button></div>
      <div class="setrow"><span class="setrow__ico">${ic('users')}</span><div class="setrow__b"><div class="setrow__t">2人で共有</div><div class="setrow__s">${S.share ? `共有中 · コード ${esc(S.share.code)}` : 'オフ'}</div></div>
        <button class="btn btn--sm" data-act="share-open">${S.share ? '管理' : '始める'}</button></div>
      <div class="setrow"><span class="setrow__ico">${ic('x')}</span><div class="setrow__b"><div class="setrow__t">記録をリセット</div><div class="setrow__s">済み・プランの条件を消去</div></div>
        <button class="btn btn--sm" data-act="reset">リセット</button></div>
    </div>
    <details class="more"><summary>詳細</summary>
      <dl class="kv" style="margin-top:8px">
        <dt>パーク</dt><dd>${esc(PARK.ja)}</dd>
        <dt>営業時間</dt><dd><span class="num">${clock(h.parkOpen)}–${clock(h.parkClose)}</span>（${h.src === 'api' ? '公式スケジュール' : '予定値'}）</dd>
        <dt>待ち時間</dt><dd>ThemeParks.wiki → 予備 Queue-Times.com。3分ごとに自動更新、15分以上古いと推定に切替</dd>
        <dt>表示</dt><dd>${kindTag('live')} 外部提供 ${kindTag('manual')} 手入力 ${kindTag('est')} 推定</dd>
        <dt>徒歩</dt><dd>直線距離×1.4 ÷ 分速70mの目安</dd>
        <dt>位置情報</dt><dd>この端末の中だけで使用</dd>
      </dl>
      ${isStandalone() ? '' : `<div class="box" style="margin-top:10px"><b>ホーム画面に追加</b>Safariの共有ボタン → 「ホーム画面に追加」</div>`}
      <div class="box" style="margin-top:10px"><b>テスト時刻</b>
        <div class="formrow" style="margin-top:6px"><input type="time" id="simAt" value="${S.sim ? hhmm(nowMin()).padStart(5, '0') : '10:00'}"><button class="btn btn--navy btn--sm" data-act="sim-set">表示</button>${S.sim ? '<button class="btn btn--sm" data-act="sim-off">解除</button>' : ''}</div></div>
      <p style="font-size:13px;margin:10px 0 0"><a href="${esc(PARK.officialUrl)}" target="_blank" rel="noopener">公式エンタメスケジュール</a> · <a href="https://disneyland.disney.go.com/guest-services/mobile-order/" target="_blank" rel="noopener">モバイルオーダー</a></p>
    </details>
    <p class="footer">非公式の個人用ツール · ThemeParks.wiki · Queue-Times.com · Wikipedia · © OpenStreetMap</p>
  </div>`);
}

// =====================================================================
// Two-person shared plan (Workers KV via /api/share/:code)
// Synced: 乗った records + plan settings (pace, conditions, must/skip, order, meals/shows, manual waits).
// Not synced: position, test time, chosen start time, temporary "別の候補".
// =====================================================================
function toDoc() {
  const f = {};
  for (const k of SHARE_FIELDS) f[k] = { at: S.fieldAt[k] || 0, v: S[k] ?? null };
  return { v: 1, done: S.done, doneMin: S.doneMin, doneDel: S.doneDel, f };
}
function applyDoc(m, { quiet = false } = {}) {
  const before = new Set(Object.keys(S.done));
  const beforeFields = Object.fromEntries(SHARE_FIELDS.map((k) => [k, JSON.stringify(S[k] ?? null)]));
  S.done = { ...m.done }; S.doneMin = { ...m.doneMin }; S.doneDel = { ...m.doneDel };
  for (const k of SHARE_FIELDS) {
    const e = m.f?.[k];
    if (!e) continue;
    S[k] = e.v == null ? structuredClone(defaults[k]) : structuredClone(e.v);
    S.fieldAt[k] = e.at;
  }
  S.prefs = { ...structuredClone(defaults.prefs), ...(S.prefs || {}) };
  const added = Object.keys(S.done).filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !S.done[id]);
  const fieldsChanged = SHARE_FIELDS.filter((k) => JSON.stringify(S[k] ?? null) !== beforeFields[k]);
  // We ride together: the partner's latest check-in is also where we are now.
  const latest = [...added].sort((a, b) => S.done[b] - S.done[a])[0];
  if (latest && (!S.lastDone || S.done[latest] > S.lastDone.at)) S.lastDone = { id: latest, at: S.done[latest] };
  snap = snapOf();
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* full */ }
  if (!added.length && !removed.length && !fieldsChanged.length) return;
  if (added.length) R.replanned = { at: Date.now(), text: `${clock(nowMin())} 相手が ${added.map(doneName).join('・')} を完了 → ここからプランを更新` };
  else if (removed.length) R.replanned = { at: Date.now(), text: `${clock(nowMin())} 相手が ${removed.map(doneName).join('・')} を未完了に戻しました` };
  else if (fieldsChanged.length) R.replanned = { at: Date.now(), text: `${clock(nowMin())} 相手がプランの条件・順番を変更しました` };
  if (!quiet) {
    const msg = added.length ? `相手の端末：${added.map(doneName).join('・')} 完了` : removed.length ? `相手の端末：${removed.map(doneName).join('・')} を未完了に` : '相手がプランを変更しました';
    toast(msg, 'ok');
  }
  if (!R.dragging && !R.draft) renderAll();
}
async function shareFetch(method, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`/api/share/${S.share.code}?${API_Q}`, { method, cache: 'no-store', signal: ctl.signal, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error === 'storage-not-configured' ? '共有の保存先が未設定です' : `HTTP ${res.status}`);
    return j;
  } finally { clearTimeout(t); }
}
function schedulePush() {
  clearTimeout(R.sharePushTimer);
  R.sharePushTimer = setTimeout(pushShare, 700);
}
async function pushShare() {
  if (!S.share) return;
  try {
    const j = await shareFetch('POST', { doc: toDoc() });
    R.shareAt = Date.now(); R.shareErr = null;
    applyDoc(mergeDocs(toDoc(), j.doc));
  } catch (e) { R.shareErr = e.name === 'AbortError' ? 'タイムアウト' : e.message; }
}
async function pullShare({ quiet = false } = {}) {
  if (!S.share || R.shareBusy) return;
  R.shareBusy = true;
  try {
    const j = await shareFetch('GET');
    R.shareAt = Date.now(); R.shareErr = null;
    const merged = mergeDocs(toDoc(), j.doc);
    applyDoc(merged, { quiet });
    // This phone had something newer (or the room is new): send it.
    if (!j.exists || !sameDoc(merged, mergeDocs(j.doc, j.doc))) await pushShare();
  } catch (e) { R.shareErr = e.name === 'AbortError' ? 'タイムアウト' : e.message; }
  finally { R.shareBusy = false; }
}
const shareLink = () => `${location.origin}/#share=${S.share.code}`;
function startShare() {
  S.share = { code: newCode() };
  // Stamp current settings so they become the shared starting point.
  const now = Date.now();
  for (const k of SHARE_FIELDS) S.fieldAt[k] = S.fieldAt[k] || now;
  save();
  pushShare().then(() => {
    const err = R.shareErr;
    if (err) { S.share = null; R.shareErr = null; save(); }
    openShare();
    toast(err ? `共有を開始できませんでした（${err}）` : '共有を始めました。リンクを相手に送ってください', err ? 'error' : 'ok');
  });
}
function joinShare(code) {
  code = String(code || '').trim().toLowerCase();
  if (!CODE_RE.test(code)) return toast('8文字の共有コードを入力してください', 'error');
  S.share = { code }; save();
  if (location.hash) history.replaceState(null, '', location.pathname);
  pullShare({ quiet: true }).then(() => {
    const err = R.shareErr;
    if (err) { S.share = null; R.shareErr = null; save(); }
    closeSheet(); go('plan');
    toast(err ? `参加できませんでした（${err}）` : '2人の共有プランに参加しました', err ? 'error' : 'ok');
  });
}
function leaveShare() {
  S.share = null; R.shareAt = 0; R.shareErr = null; save(); closeSheet(); renderAll();
  toast('共有をやめました（この端末の記録はそのまま）');
}
function shareStatus() {
  if (!S.share) return '';
  if (R.shareErr) return `同期できません：${R.shareErr}`;
  if (!R.shareAt) return '同期中…';
  const s2 = Math.round((Date.now() - R.shareAt) / 1000);
  return `同期 ${s2 < 60 ? s2 + '秒前' : Math.round(s2 / 60) + '分前'}`;
}
function openShare() {
  if (S.share) {
    openSheet(`<div class="sheet__content">
      <div><div class="kicker">Share</div><h2 class="sheet__title" id="sheetTitle">2人で共有中</h2></div>
      <div class="sharecode"><span>共有コード</span><b class="num">${esc(S.share.code)}</b></div>
      <div class="btnrow"><button class="btn btn--primary" data-act="share-send">${ic('users')}リンクを送る</button><button class="btn" data-act="share-copy">コピー</button></div>
      <p class="para muted" style="font-size:13px;margin:0">相手はリンクを開くか、設定の「2人で共有」でこのコードを入力すると参加できます。</p>
      <dl class="kv"><dt>状態</dt><dd>${esc(shareStatus())}</dd>
        <dt>共有する</dt><dd>乗った記録・順番・条件・ごはんとショー・手入力の待ち時間</dd>
        <dt>共有しない</dt><dd>現在地・テスト時刻・指定した開始時刻</dd></dl>
      <div class="btnrow"><button class="btn" data-act="share-sync">${ic('refresh')}今すぐ同期</button><button class="btn" data-act="share-leave">共有をやめる</button></div>
    </div>`);
    return;
  }
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">Share</div><h2 class="sheet__title" id="sheetTitle">2人で同じプランを使う</h2></div>
    <p class="para" style="margin:0">どちらかが「乗った」を押したり、順番・条件を変えると、もう1台のプランも自動で変わります（数十秒〜1分ほど）。</p>
    <button class="btn btn--primary btn--block" data-act="share-start">${ic('users')}共有を始める（リンクを作る）</button>
    <div class="field__h" style="margin:4px 0 0"><b>相手から届いたコードで参加</b></div>
    <div class="formrow"><input type="text" id="shareCodeIn" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="8" placeholder="8文字のコード" style="flex:1"><button class="btn btn--navy btn--sm" data-act="share-join">参加</button></div>
    <p class="muted" style="font-size:12px;margin:0">保存するのはプランと記録だけで、位置情報は送りません。7日で自動削除。</p>
  </div>`);
}
function offerJoinFromLink() {
  const m = /share=([a-z2-9]{8})/i.exec(location.hash || '');
  if (!m) return;
  const code = m[1].toLowerCase();
  if (S.share?.code === code) { history.replaceState(null, '', location.pathname); return; }
  openSheet(`<div class="sheet__content" style="text-align:center">
    <div class="kicker">Share</div><h2 class="sheet__title" id="sheetTitle">共有プランに参加しますか？</h2>
    <p class="para">コード <b class="num">${esc(code)}</b> のプランと同期します。この端末の「乗った」記録は合算され、条件や順番は新しく変えた方に合わせます。${S.share ? '<br>（いまの共有はやめて切り替えます）' : ''}</p>
    <div class="btnrow"><button class="btn" data-act="share-decline" data-close>やめる</button><button class="btn btn--primary" data-share-join="${code}">参加する</button></div>
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
  if (tab === 'map') { if (S.gps) requestFix(); else gpsIfGranted(); }
}
function renderView(tab = S.tab) {
  if (R.dragging) { R.pendingRender = true; return; }
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
    // Same target as the home card (which follows the saved plan) — not a fresh recommendation.
    const r = homeReco(c);
    R.mapNextKey = mapNextKey(r);
    mapMod.draw({
      bounds: PARK.bounds,
      filter: S.mapFilter, pos: position(), gps: R.gpsPos && S.gps && Date.now() - R.gpsPos.at < 5 * 60e3 ? R.gpsPos : null,
      rides: ATTRACTIONS.map((a) => ({ a, pos: coordsOf(a.id), w: waitInfo(a), done: !!S.done[a.id] })),
      food: RESTAURANTS.filter((x) => !R.mapFood || R.mapFood.ids.includes(x.id)).map((x) => ({ r: x, pos: coordsOf(x.id) })),
      shows: SHOWS.map((s) => ({ s, pos: s.venuePos })),
      nextId: R.mapFood?.one ? null : r.primary?.a?.id || null,
      nextPos: R.mapFood?.one ? null : (r.primary?.type === 'ride' ? null : (r.primary?.anchor || r.primary?.next)?.pos || null),
      target: R.mapFood?.one ? { id: R.mapFood.ids[0] } : null,
      icons: { food: ic('food'), show: ic('show') },
      coordsSrc: (() => { const n = Object.keys(R.meta?.coords || {}).filter((k) => attractionById[k]).length; return n >= 15 ? 'api' : n > 0 ? 'partial' : 'approx'; })(),
    });
    document.querySelectorAll('[data-mf]').forEach((b) => b.classList.toggle('is-active', b.dataset.mf === S.mapFilter));
    if (R.mapFood?.one && !R.mapFood.fitted) {
      R.mapFood.fitted = true;
      const g = R.gpsPos && S.gps ? R.gpsPos : null;
      setTimeout(() => mapMod.fitTo([g, coordsOf(R.mapFood.ids[0])]), 220);
    }
    let fc = el.querySelector('#mapFoodChip');
    if (R.mapFood) {
      if (!fc) { fc = document.createElement('button'); fc.id = 'mapFoodChip'; fc.className = 'chip is-active'; fc.dataset.act = 'map-food-clear'; el.querySelector('.mapbar').prepend(fc); }
      fc.innerHTML = R.mapFood.one ? `${esc(R.mapFood.q)} ${ic('x')}` : `「${esc(R.mapFood.q)}」の店 ${R.mapFood.ids.length}件 ${ic('x')}`;
    } else fc?.remove();
    const meOn = !!(S.gps && R.gpsPos);
    const meBtn = el.querySelector('[data-act="map-me"]');
    if (meBtn) {
      meBtn.classList.toggle('is-on', meOn);
      meBtn.classList.toggle('has-label', !meOn);
      meBtn.innerHTML = ic('locate') + (meOn ? '' : '<span>現在地を表示</span>');
      meBtn.setAttribute('aria-label', meOn ? '現在地に移動' : '現在地を表示');
    }
    const p = r.primary;
    const shop = R.mapFood?.one ? restaurantById[R.mapFood.ids[0]] : null;
    const dest = shop ? { name: shop.ja, pos: coordsOf(shop.id), open: `data-open-food="${shop.id}"`, k: 'GO' } : p?.type === 'ride' ? { name: p.a.short, pos: coordsOf(p.a.id), wait: p.wait, open: `data-open="${p.a.id}"` } : p?.type === 'anchor' || (p?.type === 'free' && p.next) ? (() => { const x = p.anchor || p.next; return { name: x.title + (x.kind === 'meal' && x.place ? '・' + x.place : ''), pos: x.pos, open: x.kind === 'show' && x.show ? `data-open-show="${x.show}"` : `data-anchor-edit="${x.id}"`, k: p.type === 'free' && r.leaveBy ? `NEXT · ${clock(r.leaveBy)}に移動` : null }; })() : null;
    const me = position();
    $('#mapcard').hidden = !dest;
    if (dest) {
      $('#mapcard').innerHTML = `<button class="mapdest__b" style="text-align:left" ${dest.open}><div class="mapdest__k">${dest.k || 'NEXT'}</div><div class="mapdest__n">${esc(dest.name)}</div>
        <div class="mapdest__m">${me.lat != null ? `徒歩${walkMin(me, dest.pos)}分` : '現在地未設定'}${dest.wait != null ? ` · 待ち${dest.wait}分` : ''}${mapMod.coordsNote()}</div></button>
        <a class="btn btn--primary btn--sm" ${routeAttr(dest.pos)}>${ic('route')}ルート</a>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="note note--bad" style="margin:12px">${ic('alert')}<div>地図を読み込めませんでした（${esc(e.message)}）</div></div>`;
  }
}

// Identity of the map's NEXT target, to notice when the plan has moved on while the map stays open.
function mapNextKey(r) { const p = r?.primary; return p ? `${p.type}:${p.a?.id || p.anchor?.id || p.next?.id || ''}` : ''; }

// ---------- park switch + trip day ----------
function renderParkSwitch() {
  const el = $('#parkSw');
  if (!el) return;
  el.innerHTML = PARK_ORDER.map((id) => `<button type="button" class="${id === PARK_ID ? 'is-active' : ''}" data-park="${id}" aria-pressed="${id === PARK_ID}">${esc(PARKS[id].PARK.short)}</button>`).join('');
}
function switchPark(id) {
  if (!PARKS[id]) return;
  if (id === PARK_ID) return openDaySettings();
  save();
  try { localStorage.setItem(PARK_STORE, id); } catch { /* private mode */ }
  location.reload();
}
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
function openDaySettings() {
  const h = hours();
  const ph = parkHours();
  const src = ph.src === 'api' ? '公式' : '予定';
  openSheet(`<div class="sheet__content">
    <div><div class="kicker">${esc(PARK.en)}</div><h2 class="sheet__title" id="sheetTitle">${esc(PARK.short)}の日程</h2></div>
    <div class="form">
      <label class="field"><div class="field__h"><b>日付</b><span>予定 ${esc(dateLabel(TRIP.date))}</span></div>
        <input type="date" id="dayDate" value="${tripDate()}"></label>
      <label class="field"><div class="field__h"><b>入園</b><span>開園 ${clock(ph.open)}（${src}）</span></div>
        <input type="time" id="dayEntry" step="300" value="${toHHMM(h.open)}"></label>
      <label class="field"><div class="field__h"><b>退園</b><span>閉園 ${clock(ph.close)}（${src}）</span></div>
        <input type="time" id="dayExit" step="300" value="${toHHMM(Math.min(h.close, 24 * 60 - 1))}"></label>
      <p class="muted" style="font-size:12.5px;margin:0">入園〜退園の間でプランを組み直します。時間外のごはん・ショーは外します。</p>
    </div>
    <div class="btnrow"><button class="btn" data-act="day-reset">開園〜閉園に戻す</button><button class="btn btn--primary" data-act="day-save">保存</button></div>
  </div>`);
}
function afterDateChange(date0) { if (tripDate() !== date0) { R.hist = {}; fetchMeta(); } }
// Date / entry / exit: like every rebuild, shown as a proposal first (反映 to apply).
function setDay(cfg, msg) {
  closeSheet();
  proposeRebuild(`${msg || '日程を変更'}（${dateLabel(cfg.date || TRIP.date)}）`, () => { S.cfg = cfg; });
}
function saveDaySettings() {
  const date = $('#dayDate').value;
  const e = parseHHMM($('#dayEntry').value || '0:00'), x = parseHHMM($('#dayExit').value || '0:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日付を選んでください', 'error');
  if (!(x - e >= 60)) return toast('退園は入園の1時間以上あとにしてください', 'error');
  // park hours depend on the date: look them up for the new date, keep entry/exit only when they differ
  const cfg0 = S.cfg;
  S.cfg = { ...S.cfg, date: date === TRIP.date ? null : date };
  const ph = parkHours();
  const cfg = { ...S.cfg, entry: e === ph.open ? null : e, exit: x === ph.close ? null : x };
  S.cfg = cfg0;
  setDay(cfg, '日程を変更');
}

function renderAll() { renderClock(); renderStatus(); renderView(); if (R.draft && !$('#sheet').hidden) openPlanBuilder(); }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-open]');
  if (!t) return;
  const d = t.dataset;
  if (d.route) {
    // Refresh the start point with the newest GPS fix right before leaving for Google Maps.
    const [lat, lon] = d.route.split(',').map(Number);
    t.href = routeUrl({ lat, lon });
    return;
  }
  if (d.tab) return go(d.tab);
  if (d.park) return switchPark(d.park);
  if (d.tabGo) { closeSheet(); return go(d.tabGo); }
  if (d.open) return openAttraction(d.open);
  if (d.openFood) return openFood(d.openFood);
  if (d.openShow) return openShow(d.openShow);
  if (d.done) return markDone(d.done);
  if (d.undo) return undoDone(d.undo);
  if (d.add) { const how = d.addHow || R.addMode; closeSheet(); return addToPlan(d.add, how); }
  if (d.addMode) { R.addMode = d.addMode; return openAddSheet(); }
  if (d.rm) return removeFromPlan(d.rm);
  if (d.lock) {
    const id = d.lock;
    S.locks = { ...(S.locks || {}) };
    if (S.locks[id]) delete S.locks[id]; else S.locks[id] = true;
    save(); renderView();
    return toast(S.locks[id] ? `${itemLabel(id)} をこの位置に固定しました（作り直しても動きません）` : `${itemLabel(id)} の固定を解除しました`, 'ok');
  }
  if (d.mealDur) {
    S.prefs.mealOverrides[d.mealDur] = { ...(S.prefs.mealOverrides[d.mealDur] || {}), dur: Number(d.v) }; relayout('ごはん'); renderView();
    return openAnchorEdit('meal:' + d.mealDur);
  }
  if (d.pin) {
    if (S.planSnap?.seq) layoutPlan([d.pin, ...planSeq().filter((x) => x !== d.pin)], '並べ替え');
    S.pin = { id: d.pin, until: nowMin() + 30 }; R.alerts = R.alerts.filter((x) => x.id !== d.pin); save();
    go('home'); return toast(`${attractionById[d.pin].short} を次の行き先にしました`, 'ok');
  }
  if (d.dismissAlert) { R.alerts = R.alerts.filter((x) => x.id !== d.dismissAlert); return renderHome(); }
  if (d.skip) return skipFor(d.skip);
  if (d.xtab) { S.exploreTab = d.xtab; save(); return renderExplore(); }
  if (d.xf) { S.exploreFilter = d.xf; save(); return renderExplore(); }
  if (d.ff) { S.foodFilter = d.ff; save(); return renderExplore(); }
  if (d.foodMap) {
    const r = restaurantById[d.foodMap];
    closeSheet(); S.mapFilter = 'food'; R.mapFood = { q: r.ja.split('・')[0], ids: [r.id], one: true }; save();
    if (!S.gps) gpsIfGranted();
    return go('map');
  }
  if (d.fq !== undefined) { S.foodQ = S.foodQ === d.fq ? '' : d.fq; save(); return renderExplore(); }
  if (d.mf) { S.mapFilter = d.mf; save(); document.querySelectorAll('[data-mf]').forEach((b) => b.classList.toggle('is-active', b.dataset.mf === d.mf)); return renderMap(); }
  if (d.land) { S.land = d.land; S.landAt = Date.now(); save(); if (S.planSnap?.items) checkSuggest(); renderAll(); return toast(landById[d.land].ja, 'ok'); }
  if (d.rideSt) {
    const id = d.rideSt, must = mustMap();
    delete must[id]; delete S.excluded[id];
    if (d.v === 'must') must[id] = true;
    if (d.v === 'skip') S.excluded[id] = true;
    S.must = must;
    if (S.planSnap?.seq) {
      const seq = planSeq();
      if (d.v === 'must' && !seq.includes(id)) layoutPlan(bestSlot(seq, id), '追加');
      else if (d.v === 'skip' && seq.includes(id)) layoutPlan(seq.filter((x) => x !== id), '削除');
      else save();
    } else save();
    renderView(); openAttraction(id);
    return toast(d.v === 'must' ? '絶対乗るに追加' : d.v === 'skip' ? '乗らないに設定' : 'おまかせに設定', 'ok');
  }
  if (d.anchorEdit) return openAnchorEdit(d.anchorEdit);
  if (d.pickShow) {
    S.prefs.shows[d.pickShow] = { ...(S.prefs.shows[d.pickShow] || {}), on: true, pick: d.time }; relayout('ショー'); renderAll();
    if (!$('#sheet').hidden) openShow(d.pickShow);
    return toast(`${showById[d.pickShow].short} ${d.time} の回に`, 'ok');
  }
  if (d.showOff) {
    S.prefs.shows[d.showOff] = { ...(S.prefs.shows[d.showOff] || {}), on: false }; relayout('ショー'); renderAll(); openShow(d.showOff);
    return toast(`${showById[d.showOff].short} をプランから外しました`);
  }
  if (d.saveTimes) {
    const v = $('#showTimesIn').value.split(/[,、\s]+/).map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x));
    if (v.length) S.prefs.showTimes[d.saveTimes] = v; else delete S.prefs.showTimes[d.saveTimes];
    relayout('ショー'); renderAll(); openShow(d.saveTimes); return toast(v.length ? '時刻を保存しました' : '自動の時刻に戻しました', 'ok');
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
    S.prefs.mealOverrides[d.mealStep] = { ...(S.prefs.mealOverrides[d.mealStep] || {}), at: v }; relayout('ごはん'); renderView();
    return openAnchorEdit('meal:' + d.mealStep);
  }
  if (d.mealRest) {
    S.prefs.mealOverrides[d.mealRest] = { ...(S.prefs.mealOverrides[d.mealRest] || {}), restaurant: d.rest }; relayout('ごはん'); renderView();
    return openAnchorEdit('meal:' + d.mealRest);
  }
  if (d.mealOff) {
    const o = S.prefs.mealOverrides[d.mealOff] = { ...(S.prefs.mealOverrides[d.mealOff] || {}) }; o.off = !o.off; relayout('ごはん'); closeSheet(); renderAll();
    return toast(o.off ? '今日は省略にしました' : '予定に戻しました');
  }
  if (d.mealReset) { delete S.prefs.mealOverrides[d.mealReset]; relayout('ごはん'); closeSheet(); renderAll(); return toast('初期設定に戻しました'); }
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
  if (d.shareJoin) return joinShare(d.shareJoin);
  switch (d.act) {
    case 'refresh': return fetchLive({ manual: true });
    case 'app-update': return applyUpdate();
    case 'share-open': return openShare();
    case 'food-map': S.mapFilter = 'food'; R.mapFood = { q: S.foodQ, ids: R.foodHits || [] }; save(); return go('map');
    case 'map-food-clear': R.mapFood = null; return renderMap();
    case 'share-start': return startShare();
    case 'share-join': return joinShare($('#shareCodeIn')?.value);
    case 'share-decline': history.replaceState(null, '', location.pathname); return;
    case 'share-leave': if (!confirm('共有をやめますか？（この端末の記録は残ります）')) return; return leaveShare();
    case 'share-sync': await pullShare(); return openShare();
    case 'share-copy':
      try { await navigator.clipboard.writeText(shareLink()); toast('リンクをコピーしました', 'ok'); } catch { prompt('このリンクを相手に送ってください', shareLink()); }
      return;
    case 'share-send':
      if (navigator.share) { try { await navigator.share({ title: `${dateLabel()} ${PARK.short} プラン共有`, text: '一緒のプランを使おう', url: shareLink() }); } catch { /* cancelled */ } return; }
      try { await navigator.clipboard.writeText(shareLink()); toast('リンクをコピーしました。LINEなどで送ってください', 'ok'); } catch { prompt('このリンクを相手に送ってください', shareLink()); }
      return;
    case 'plan-time-set': {
      const raw = $('#planTimeInput')?.value;
      const mins = parseHHMM(raw);
      if (!raw || !Number.isFinite(mins) || mins < 0 || mins >= 1440) return toast('開始時刻を正しく入力してください', 'error');
      return proposeRebuild(`${raw} から作り直す`, () => { S.planTime = { base: mins, setAt: Date.now() }; S.sim = null; });
    }
    case 'plan-time-auto':
      return proposeRebuild('現在時刻から作り直す', () => { S.planTime = null; S.sim = null; });
    case 'b-start-now':
      if (R.draft) { R.draft.startMode = 'auto'; return openPlanBuilder(); }
      return;
    case 'plan-edit': R.draft = null; return openPlanBuilder();
    case 'plan-edit-shows': R.draft = null; return openPlanBuilder('shows');
    case 'plan-apply': return applyPlanDraftProposal();
    case 'proposal-apply': return applyProposal();
    case 'proposal-cancel': return cancelProposal();
    case 'day-edit': return openDaySettings();
    case 'day-save': return saveDaySettings();
    case 'day-reset': return setDay({ ...S.cfg, entry: null, exit: null }, '開園〜閉園に戻す');
    case 'plan-add': return openAddSheet();
    case 'sync-paused': syncPaused(); return renderAll();
    case 'plan-edit-order': R.planEdit = true; return renderPlan();
    case 'plan-edit-done': R.planEdit = false; return renderPlan();
    case 'prog-toggle': R.progOpen = !R.progOpen; return renderHome();
    case 'replan': return replan();
    case 'gps-start': return startGPS(true);
    case 'gps-stop': return stopGPS();
    case 'pick-land': return openLandPicker();
    case 'suggest-apply': return applySuggest();
    case 'suggest-preview': return openSuggestPreview();
    case 'suggest-off': S.suggestOff = R.suggest?.sig; R.suggest = null; save(); return renderAll();
    case 'sim-set': { const m = parseHHMM($('#simAt').value); S.sim = { base: m, setAt: Date.now() }; buildPlan('テスト時刻'); closeSheet(); renderAll(); return toast(`${hhmm(m)} として表示中`, 'ok'); }
    case 'sim-off': S.sim = null; buildPlan('テスト時刻'); closeSheet(); renderAll(); return toast('現在時刻に戻しました');
    case 'reset':
      if (!confirm('済みの記録とプランの条件をすべてリセットしますか？')) return;
      { const cfg = S.cfg; Object.keys(S).forEach((k) => delete S[k]); Object.assign(S, structuredClone(defaults), { cfg, shareAdopted: true }); }
      snap = null; save(); closeSheet(); renderAll();
      return toast('リセットしました（2人の共有もやめました・日程はそのまま）');
    case 'map-me':
      if (!S.gps || !R.gpsPos) return startGPS(true);
      mapMod?.locate(R.gpsPos);
      if (Date.now() - R.gpsPos.at > 20e3) requestFix({ force: true });
      return;
    case 'map-fit': return mapMod?.fit();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'foodQ') return;
  S.foodQ = e.target.value; save();
  const box = $('#foodList');
  if (box) box.innerHTML = foodListHtml(ctx());
  document.querySelectorAll('[data-fq]').forEach((b) => b.classList.toggle('is-active', !!b.dataset.fq && b.dataset.fq === S.foodQ.trim()));
});
document.addEventListener('change', (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.xsort !== undefined) { S.exploreSort = t.value; save(); renderExplore(); }
  if (d.gpsToggle !== undefined) { if (t.checked) startGPS(true); else stopGPS(); setTimeout(() => { if (!$('#sheet').hidden) openSettings(); }, 50); }
  if (R.draft) {
    const D = R.draft;
    if (d.bStart !== undefined) {
      const mins = parseHHMM(t.value);
      if (!t.value || !Number.isFinite(mins) || mins < 0 || mins >= 1440) return toast('開始時刻を正しく入力してください', 'error');
      D.startMin = mins; D.startMode = 'custom'; return openPlanBuilder();
    }
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
// Two phones already sharing at one park keep sharing at the other (same code, separate plan room).
if (!S.share && !S.shareAdopted) {
  for (const id of PARK_ORDER) {
    if (id === PARK_ID) continue;
    try { const o = JSON.parse(localStorage.getItem(PARKS[id].PARK.storeKey) || '{}'); if (o.share?.code && CODE_RE.test(o.share.code)) S.share = { code: o.share.code }; } catch { /* ignore */ }
  }
  S.shareAdopted = true; save();
}
document.title = `${dateLabel()} ${PARK.short} Day Navi`;
document.documentElement.dataset.park = PARK_ID;
document.querySelector('meta[name=theme-color]')?.setAttribute('content', PARK_ID === 'dca' ? '#123329' : '#0f1a45');
renderParkSwitch();
measure();
addEventListener('resize', measure);
go(S.tab || 'home');
renderStatus();
fetchMeta();
fetchPhotos();
const shouldPoll = () => { const m = nowMin(); return m >= hours().open - 90 && m <= hours().close + 30; };
fetchLive();
setInterval(() => { if (document.visibilityState === 'visible' && shouldPoll()) fetchLive(); }, 3 * 60e3);
// Shared plan: pull every 20 s while visible (cheap GET), push right after local changes.
if (S.share) pullShare({ quiet: true });
setInterval(() => { if (S.share && document.visibilityState === 'visible') pullShare(); }, 20e3);
offerJoinFromLink();
addEventListener('hashchange', offerJoinFromLink);
setInterval(() => { renderClock(); renderStatus(); }, 15e3);
// Re-render the current view every minute so countdowns/plans follow the clock (skip while a sheet is open).
setInterval(() => { if ($('#sheet').hidden && S.tab !== 'map' && document.activeElement?.tagName !== 'INPUT') renderView(); }, 60e3);
// The map stays put (no redraw that would close popups) unless its NEXT target has changed.
setInterval(() => { if ($('#sheet').hidden && S.tab === 'map' && mapNextKey(homeReco(ctx())) !== R.mapNextKey) renderMap(); }, 30e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderClock(); renderStatus(); if ($('#sheet').hidden) renderView();
    if (Date.now() - R.liveReceivedAt > 2 * 60e3) fetchLive();
    if (S.gps) requestFix();
    if (S.share) pullShare();
  }
});
// Resume GPS automatically only if the user enabled it before AND the browser already granted permission.
if (S.gps && navigator.permissions?.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') requestFix({ force: true }); else { S.gps = false; save(); } }).catch(() => {});
}
// Throttled position refresh (see requestFix): checks every 20 s, fetches only when due.
setInterval(() => { if (S.gps) requestFix(); }, 20e3);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- app updates ----------
// A page that stays open keeps running the code it was loaded with. Check for a newer deploy
// (ETag of the app code) when the app comes back to the foreground and every 10 minutes.
// If there is one: reload right away when it is safe (coming back after a while, nothing open),
// otherwise show a banner with a one-tap 更新.
const UPDATE_FILES = ['/css/theme.css', '/js/app.js', '/js/engine.js', '/js/map.js', '/js/data.js', '/js/parks/dl.js', '/js/parks/dca.js', '/css/app.css'];
let codeTag = null, hiddenAt = 0;
async function currentCodeTag() {
  const tags = await Promise.all(UPDATE_FILES.map((u) => fetch(u, { method: 'HEAD', cache: 'no-store' }).then((r) => (r.ok ? r.headers.get('etag') || r.headers.get('last-modified') || '' : '')).catch(() => '')));
  return tags.every((t) => !t) ? null : tags.join('|');
}
function safeToReload() { return !R.dragging && $('#sheet').hidden && !R.draft && document.activeElement?.tagName !== 'INPUT'; }
function applyUpdate() { try { navigator.serviceWorker?.getRegistration().then((r) => r?.update()); } catch { /* ignore */ } location.reload(); }
async function checkForUpdate({ allowAutoReload = false } = {}) {
  const tag = await currentCodeTag();
  if (!tag) return;
  if (codeTag == null) { codeTag = tag; return; }
  if (tag === codeTag) return;
  R.updateReady = true;
  if (allowAutoReload && safeToReload()) return applyUpdate();
  const b = $('#banner');
  b.hidden = false; b.className = 'banner is-update';
  b.innerHTML = `<span>新しいバージョンがあります</span><button class="btn btn--sm btn--primary" data-act="app-update">${ic('refresh')}更新</button>`;
  document.documentElement.style.setProperty('--bnr', b.offsetHeight + 'px');
}
setTimeout(() => checkForUpdate(), 3000);
setInterval(() => { if (document.visibilityState === 'visible') checkForUpdate(); }, 10 * 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  // Back after 30 s or more: a quick, quiet reload is fine if a new version is out.
  checkForUpdate({ allowAutoReload: hiddenAt && Date.now() - hiddenAt > 30e3 });
});
window.__dlnavi = { S, R, ctx, hours, homeReco, park: PARK_ID, recommend, simulateDay, pullShare, renderMap: () => renderMap(), layoutPlan, checkSuggest, renderAll: () => renderAll() };

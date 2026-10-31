import {
  TRIP, LANDS, landById, ATTRACTIONS, attractionById, RESTAURANTS, restaurantById, POPCORN, SHOWS, showById, PLANS, PRIORITY,
} from './data.js';
import {
  recommend, simulateDay, buildAnchors, anchorConflicts, crowdRatio, walkMin, distanceM, hhmm, parseHHMM, estimateWait, availability,
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
  gps: false,          // user explicitly enabled GPS
  land: null,          // manual "I'm around here" land id
  landAt: 0,
  lastDone: null,      // { id, at }
  sim: null,           // { base: minutes, setAt: ms } — time simulation for testing
  pin: null,           // { id, until } destination chosen from an alert
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
const credit = (key) => { const p = R.photos?.[key]; if (!p) return ''; return `📷 ${[p.author, p.license].filter(Boolean).join(' · ') || p.title} / ${p.source || 'Wikimedia'}`; };

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
function ctx(extra = {}) {
  const h = hours();
  const live = liveMap();
  const now = nowMin();
  return {
    now, openMin: h.open, closeMin: h.close, pos: (() => { const p = position(); return p.lat == null ? null : p; })(),
    planId: S.plan, done: S.done, excluded: S.excluded, skip: S.skip, live, crowd: crowdRatio(live, now),
    anchors: anchors(), coords: coordsMap(), pin: S.pin, ...extra,
  };
}

// =====================================================================
// Images: Wikipedia photo when available, otherwise a retro poster tile
// =====================================================================
function poster(name, emoji, color) {
  return `<div class="poster" style="--c:${color || 'var(--navy)'}"><div><div class="poster__emoji">${emoji || '★'}</div><div class="poster__name">${esc(name || '')}</div></div></div>`;
}
const RIDE_EMOJI = { rise: '🚀', falcon: '🛸', indy: '🗿', space: '🌌', haunted: '👻', thunder: '⛰️', mmrr: '🚂', pirates: '🏴‍☠️', matterhorn: '🏔️', jungle: '🌴', tiana: '💦', startours: '✨', smallworld: '🌍', peterpan: '🧚', toad: '🐸', alice: '🐛', buzz: '🔫', autopia: '🏎️', nemo: '🐠', tiki: '🦜', marktwain: '🛳️', railroad: '🚂' };
function imgFor(key, { name, emoji, color } = {}) {
  const p = R.photos?.[key];
  const fb = esc(JSON.stringify({ name, emoji, color }));
  if (p?.src) return `<img class="img" loading="lazy" decoding="async" src="${esc(p.src)}" alt="${esc(name)}の写真" data-fb="${fb}">`;
  return poster(name, emoji, color);
}
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t?.tagName === 'IMG' && t.dataset.fb) {
    try { const f = JSON.parse(t.dataset.fb); t.outerHTML = poster(f.name, f.emoji, f.color); } catch { t.remove(); }
  }
}, true);
const rideImg = (a) => imgFor(a.id, { name: a.en, emoji: RIDE_EMOJI[a.id], color: landById[a.land]?.color });
const foodImg = (r) => imgFor('food_' + r.id, { name: r.en, emoji: r.emoji, color: '#2e6b4f' });

// =====================================================================
// UI primitives
// =====================================================================
let toastTimer;
function toast(msg, type = '', action = null) {
  const el = $('#toast');
  el.className = 'toast is-on' + (type ? ' is-' + type : '');
  el.innerHTML = esc(msg) + (action ? ` <button class="linkbtn" style="color:#ffe7a8;margin-left:8px" id="toastAct">${esc(action.label)}</button>` : '');
  el.style.pointerEvents = action ? 'auto' : 'none';
  if (action) $('#toastAct').onclick = () => { action.fn(); el.className = 'toast'; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; el.style.pointerEvents = 'none'; }, action ? 5500 : 2800);
}
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

const routeUrl = (pos) => `https://www.google.com/maps/dir/?api=1&destination=${pos.lat},${pos.lon}&travelmode=walking`;
const stars = (n, max = 5) => `<span class="meter" aria-label="${n}/${max}">${'●'.repeat(n)}<i>${'●'.repeat(max - n)}</i></span>`;
const doneRides = () => Object.keys(S.done).filter((k) => attractionById[k]);

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
// Tap = complete immediately (with undo in the toast). Tapping a completed item never deletes it
// silently: it asks first, and even after reverting the toast offers to restore it.
function markDone(id) {
  if (S.done[id]) return openUndoConfirm(id);
  S.done[id] = Date.now();
  S.doneMin[id] = nowMin();
  S.lastDone = { id, at: Date.now() };
  delete S.skip[id];
  if (S.pin?.id === id) S.pin = null;
  save(); renderAll();
  const n = doneRides().length;
  toast(`✓ ${doneName(id)} 完了！${attractionById[id] ? `（${n}つ目）` : ''}`, 'ok', { label: '取り消す', fn: () => undoDone(id, true) });
}
function undoDone(id, silent = false) {
  const prev = { at: S.done[id], min: S.doneMin[id] };
  delete S.done[id]; delete S.doneMin[id];
  if (S.lastDone?.id === id) S.lastDone = null;
  save(); renderAll();
  if (!silent) toast(`↺ ${doneName(id)} を未完了に戻しました`, '', { label: '完了に戻す', fn: () => { S.done[id] = prev.at; S.doneMin[id] = prev.min; save(); renderAll(); } });
}
function openUndoConfirm(id) {
  const m = S.doneMin[id];
  openSheet(`<div class="sheet__content" style="padding-top:30px;text-align:center">
    <div style="font-size:44px">✅</div>
    <h2 class="sheet__title" id="sheetTitle">${esc(doneName(id))}</h2>
    <p class="para" style="color:var(--muted);font-weight:800">${m != null ? `${clock(m)} に完了` : '完了済み'}</p>
    <div class="btnrow btnrow--2"><button class="btn btn--ghost" data-close>そのまま</button><button class="btn btn--primary" data-undo="${id}" data-close>↺ 未完了に戻す</button></div>
  </div>`);
}
function skipFor(id, minutes = 20) {
  S.skip[id] = nowMin() + minutes; save(); renderAll();
  toast(`${attractionById[id]?.short} を${minutes}分間おすすめから外しました`, '', { label: '戻す', fn: () => { delete S.skip[id]; save(); renderAll(); } });
}
function setPlan(id) {
  if (S.plan === id) return;
  const before = simulateDay(ctx()).items.filter((i) => i.type === 'ride').map((i) => i.id);
  S.plan = id; save(); renderAll();
  const after = simulateDay(ctx()).items.filter((i) => i.type === 'ride').map((i) => i.id);
  toast(`プラン${PLANS[id].label}「${PLANS[id].ja}」に切り替えました（予定のアトラクション ${before.length}→${after.length}）`, 'ok');
}

// =====================================================================
// Render: status pill / banner / clock
// =====================================================================
function renderStatus() {
  const pill = $('#livePill'), txt = $('#livePillText');
  pill.className = 'pill';
  const age = liveAgeMin();
  if (R.liveStatus === 'loading') { pill.classList.add('is-loading'); txt.textContent = '更新中…'; }
  else if (liveIsFresh()) { pill.classList.add('is-live'); txt.textContent = `LIVE ${age < 1 ? 'いま' : Math.round(age) + '分前'}`; }
  else if (R.live?.ok) { pill.classList.add('is-stale'); txt.textContent = `${Math.round(age)}分前`; }
  else if (R.liveStatus === 'error') { pill.classList.add('is-error'); txt.textContent = '取得失敗'; }
  else { txt.textContent = '推定'; }

  const b = $('#banner');
  const phase = dayPhase();
  const msgs = [];
  if (phase === 'sim') msgs.push(`🧪 テスト時刻 ${clock(nowMin())}`);
  if (phase === 'before') msgs.push('📅 当日の朝としてプレビュー中');
  if (phase === 'after') msgs.push('🎃 10/31の営業は終了しました');
  if (R.liveStatus === 'error' && !R.live?.ok) msgs.push('⚠️ 待ち時間を取得できず → 推定値で案内中');
  else if (R.live?.ok && !liveIsFresh()) msgs.push(`⚠️ 待ち時間が古い（${Math.round(age)}分前）→ 推定値で案内中`);
  b.hidden = !msgs.length;
  b.className = 'banner' + (msgs.some((m) => m.startsWith('⚠️')) ? ' is-error' : '');
  b.innerHTML = msgs.map((m) => `<span>${esc(m)}</span>`).join('') + (msgs.some((m) => m.startsWith('⚠️')) ? '<button class="btn btn--sm btn--gold" data-act="refresh" style="margin-left:auto">↻ 再取得</button>' : '');
}
function renderClock() {
  const m = nowMin();
  $('#clock').textContent = m >= 24 * 60 ? '--:--' : clock(m);
}

// Reason keys → icon chips (visual instead of sentences)
const RCHIP = {
  must: ['★', '必須', 'must'], dip: ['📉', 'いつもより空き', 'good'], later: ['🔥', 'あとで混む', 'hot'], short: ['⏱', '待ち短め', 'good'],
  near: ['📍', 'すぐ近く', 'good'], pop: ['👑', '大人気', ''], fit: ['✅', '次の予定に間に合う', ''], bump: ['↪', '休憩を後ろへ', 'warn'],
  soft: ['⚡', '場所取り短め', 'warn'], close: ['🌙', '閉園前に並べばOK', 'warn'], pin: ['📌', 'あなたが選択', 'must'],
};
const rchips = (reasons) => `<div class="rchips">${(reasons || []).map((x) => {
  const [i, t, k] = RCHIP[x.k] || ['•', x.t, ''];
  return `<span class="rchip ${k ? 'rchip--' + k : ''}" title="${esc(x.t)}"><i>${i}</i>${esc(t)}</span>`;
}).join('')}</div>`;

// Mini time bar: now → walk → wait → ride → spare → next fixed plan
function miniBar(start, parts, endLabel, endTime) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.m), 0) || 1;
  return `<div class="minitl"><div class="minitl__bar">${parts.filter((p) => p.m > 0).map((p) => `<div class="minitl__seg minitl__seg--${p.k}" style="flex:${p.m} 1 0">${p.m / total > 0.14 ? esc(p.t) : ''}</div>`).join('')}</div>
    <div class="minitl__labels"><span>いま ${clock(start)}</span><span>${endLabel} ${clock(endTime)}</span></div></div>`;
}

// ---------- wait-time trend (today's observed values on this device) ----------
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
    <line x1="2" x2="${w - 2}" y1="${h - 3}" y2="${h - 3}" stroke="var(--soft)" stroke-width="1"/>
    <polyline fill="none" stroke="var(--navy)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>
    <circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="3.5" fill="var(--red)" stroke="var(--paper)" stroke-width="1.5"/></svg>${t ? `<b style="color:${TREND[t.dir][2]}">${TREND[t.dir][0]}</b>` : ''}</span>`;
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
  const grid = [0, ymax / 2, ymax].map((v) => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--soft)" stroke-width="1"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end" class="ax">${v}</text>`).join('');
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
      ${lastP ? `<circle cx="${X(lastP[0])}" cy="${Y(lastP[1])}" r="5" fill="var(--red)" stroke="var(--paper)" stroke-width="2"/>` : ''}
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
  const r = recommend(c);
  const done = doneRides();
  const sim = simulateDay(c);
  const plannedTotal = done.length + sim.rides;
  const pos = position();
  let html = '';

  if (c.now < h.open) {
    html += `<div class="countdown"><div><div class="countdown__k">BEFORE OPENING</div><div class="countdown__n">開園 ${clock(h.open)}</div>
      <div class="flow" style="margin-top:8px;color:var(--paper)">
        <div class="flow__step"><div class="flow__icon">🏨</div><div class="flow__s" style="color:#d9d6e8">ホテル</div></div>
        <div class="flow__step"><div class="flow__icon">🚶</div><div class="flow__s" style="color:#d9d6e8">15〜20分</div></div>
        <div class="flow__step"><div class="flow__icon">🛂</div><div class="flow__s" style="color:#d9d6e8">検査・入場</div></div>
        <div class="flow__step"><div class="flow__icon">🏰</div><div class="flow__s" style="color:#d9d6e8">${clock(h.open - 40)}着</div></div></div></div>
      <div class="countdown__v">${fmtDur(h.open - c.now)}<small>あと</small></div></div>`;
  }
  if (c.now >= h.close || dayPhase() === 'after') {
    html += `<div class="card card--pad" style="text-align:center"><div style="font-size:44px">🎃🏰✨</div><h2 style="margin:6px 0;color:var(--navy)">おつかれさま！</h2>
      <div class="progress__count">${done.length}<small> 施設</small></div>
      <div class="donelist" style="justify-content:center;margin-top:10px">${done.map((id) => `<span class="donechip">✓ ${esc(attractionById[id].short)}</span>`).join('')}</div></div>`;
    el.innerHTML = html + footer();
    return;
  }

  const live = liveMap();
  html += `<div class="card progress">
    <div><div class="progress__label">きょうの進み具合 · ${PLANS[S.plan].ja}</div><div class="progress__count">${done.length}<small> / ${Math.max(plannedTotal, done.length)}</small></div></div>
    <div class="musts">${['rise', 'falcon'].map((id) => { const down = !S.done[id] && live[id] && live[id].status !== 'OPERATING' && c.now >= h.open; return `<span class="must ${S.done[id] ? 'is-done' : down ? 'is-down' : ''}">${S.done[id] ? '✓' : down ? '🚧' : '★'} ${id === 'rise' ? 'レジスタンス' : 'ファルコン'}</span>`; }).join('')}</div>
    <div class="progress__bar"><i style="width:${Math.min(100, (done.length / Math.max(1, plannedTotal)) * 100)}%"></i></div>
  </div>`;

  for (const n of r.notes) {
    const [name, why] = n.text.split('：');
    html += `<div class="note ${n.temporary ? '' : 'note--bad'}"><span class="note__icon">${n.fit ? '⏳' : '🚧'}</span><div><div class="note__t">${esc(name)}：${esc(why)}</div>
      <div class="note__s">${n.fit ? '★ 必須なので後で必ず案内します' : n.temporary ? '★ 必須なので再開したらすぐ案内します' : 'キャストに再開予定を確認'}</div></div></div>`;
  }
  if (sim.missingMust.length && !r.notes.length) {
    html += `<div class="note note--bad"><span class="note__icon">⚠️</span><div><div class="note__t">${sim.missingMust.map((id) => esc(attractionById[id].short)).join('・')} が入りきらない</div><div class="note__s">食事・ショーの時間を見直してください</div></div></div>`;
  }

  for (const al of activeAlerts()) {
    const a = attractionById[al.id];
    html += `<div class="alert" role="alert"><div class="alert__icon">${al.type === 'reopen' ? '🎉' : '📉'}</div>
      <div class="alert__body"><div class="alert__t">${esc(a.short)} ${al.type === 'reopen' ? '再開！' : '空いてきた！'}</div>
        <div class="alert__s">${al.type === 'reopen' ? `いま 待ち${al.to ?? '?'}分` : `<s>${al.from}分</s> → <b>${al.to}分</b>`}</div></div>
      <button class="btn btn--sm btn--primary" data-pin="${al.id}">行く！</button><button class="alert__x" data-dismiss-alert="${al.id}" aria-label="閉じる">✕</button></div>`;
  }
  html += renderNextCard(r, c);

  if (r.alts.length) {
    const icon = { wait: '⏱', walk: '📍', pop: '👑', score: '✨' };
    html += `<div class="h-section" id="alts"><h2>ほかの候補</h2></div><div class="alts">`;
    for (const a of r.alts) {
      html += `<button class="alt" type="button" data-open="${a.a.id}">
        <div class="alt__img">${rideImg(a.a)}</div>
        <div><span class="alt__label">${icon[a.key] || '•'} ${esc(a.label)}</span><div class="alt__name">${esc(a.a.short)}</div>
          <div class="alt__meta">🚶${a.walk}分 · 〜${clock(a.finish)}</div></div>
        <div class="alt__wait"><b>${a.wait}<small>分</small></b><div>${kindTag(a.kind)}</div></div>
      </button>`;
    }
    html += `</div>`;
  }

  const ups = c.anchors.filter((x) => !x.done && x.end > c.now).slice(0, 4);
  if (ups.length) {
    html += `<div class="h-section"><h2>このあと</h2><button class="linkbtn" data-tab-go="plan">全部見る →</button></div><div class="card ups">`;
    html += ups.map((x) => `<button class="up up--${x.kind}" type="button" data-anchor-edit="${x.id}">
      <span class="up__time">${clock(x.start)}</span><span class="up__icon">${x.emoji}</span>
      <span><span class="up__name">${esc(x.title)}</span><br><span class="up__sub">${x.kind === 'meal' ? esc(x.place) : `場所取り ${clock(x.start - x.claim)}〜`}</span></span>
      <span class="up__edit">${x.kind === 'meal' ? '✎ 変更' : 'あと' + fmtDur(x.start - c.now)}</span></button>`).join('');
    html += `</div>`;
  }

  html += renderLocCard(pos);
  if (!isStandalone() && !S.a2hsDismissed) html += a2hsCard();
  html += renderDataCard();
  html += footer();
  el.innerHTML = html;
  renderActionBar(r);
}
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function a2hsCard() {
  return `<div class="card card--pad a2hs"><div class="h-section" style="margin:0 0 10px"><h2>📲 ホーム画面に追加</h2><button class="alert__x" data-act="a2hs-off" aria-label="閉じる">✕</button></div>
    <div class="flow">
      <div class="flow__step"><div class="flow__icon">🧭</div><div class="flow__s">Safariで開く</div></div>
      <div class="flow__step"><div class="flow__icon"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="var(--navy)" d="M12 3 7.5 7.5l1.4 1.4L11 6.8V15h2V6.8l2.1 2.1 1.4-1.4ZM5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9h-2v8H7v-8Z"/></svg></div><div class="flow__s">共有ボタン</div></div>
      <div class="flow__step"><div class="flow__icon">➕</div><div class="flow__s">ホーム画面に追加</div></div>
      <div class="flow__step"><div class="flow__icon"><img src="/icon-180.png" alt="" width="30" height="30" style="border-radius:8px"></div><div class="flow__s">アイコンから起動</div></div>
    </div>
    <div class="rchips" style="margin-top:10px"><span class="rchip rchip--good"><i>📱</i>全画面</span><span class="rchip rchip--good"><i>📶</i>電波が弱くても開ける</span><span class="rchip rchip--good"><i>⚡</i>すぐ起動</span></div></div>`;
}
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
    bar.innerHTML = `<button class="actionbar__side" data-skip="${p.a.id}" aria-label="別の候補"><span>↻</span><small>別の候補</small></button>
      <button class="actionbar__main" data-done="${p.a.id}">✓ ${esc(p.a.short)} 乗った！</button>`;
  } else {
    const x = p.anchor;
    bar.innerHTML = `<button class="actionbar__side" data-anchor-edit="${x.id}" aria-label="変更"><span>✎</span><small>変更</small></button>
      <button class="actionbar__main" data-done="${x.id}">✓ ${esc(x.title)} ${x.kind === 'show' ? '観た！' : '食べた！'}</button>`;
  }
}

function renderNextCard(r, c) {
  const p = r.primary;
  const next = r.next;
  if (!p) return `<div class="card card--pad empty">候補を計算できませんでした。</div>`;

  if (p.type === 'ride') {
    const a = p.a;
    const start = Math.max(c.now, c.openMin);
    const back = next ? walkMin(coordsOf(a.id), next.pos) : 0;
    const endT = next ? next.start - next.claim : Math.max(p.finish, c.closeMin);
    const slack = next ? Math.max(0, endT - p.finish - back) : 0;
    const bar = miniBar(start, [
      { k: 'walk', m: p.walk, t: '🚶' + p.walk }, { k: 'wait', m: p.wait, t: '⏳' + p.wait }, { k: 'ride', m: a.dur, t: '🎢' }, { k: 'slack', m: slack + back, t: next ? '余裕' : '' },
    ], next ? `${next.emoji} ${next.title}` : '閉園', next ? next.start : c.closeMin);
    return `<article class="card next">
      <div class="next__photo">${rideImg(a)}<span class="next__stamp">NEXT!</span>${R.photos[a.id] ? `<span class="next__credit">${esc(credit(a.id))}</span>` : ''}</div>
      <div class="next__body">
        <div><div class="next__kicker">${esc(landById[a.land]?.ja || '')}</div>
          <h1 class="next__title">次は${esc(a.short)}へ！</h1><div class="next__en">${esc(a.en)}</div></div>
        <div class="stats">
          <div class="stat"><div class="stat__k">⏳ 待ち</div><div class="stat__v ${waitClass(p.wait)}">${p.wait}<small>分</small></div><div class="stat__src">${kindTag(p.kind)}</div></div>
          <div class="stat"><div class="stat__k">🚶 徒歩</div><div class="stat__v">${p.walk}<small>分</small></div><div class="stat__src"><span class="tag tag--ghost">目安</span></div></div>
          <div class="stat"><div class="stat__k">🏁 終わり</div><div class="stat__v">${clock(p.finish)}</div><div class="stat__src"><span class="tag tag--ghost">見込み</span></div></div>
        </div>
        ${rchips(p.reasons)}
        ${(() => { const t = trendOf(a.id); return t && t.dir !== 'flat' ? `<div class="rchips"><span class="rchip ${t.dir === 'down' ? 'rchip--good' : 'rchip--hot'}"><i>${TREND[t.dir][0]}</i>${t.mins}分で${t.d > 0 ? '+' : ''}${t.d}分（${TREND[t.dir][1]}）</span></div>` : ''; })()}
        ${bar}
        <div class="btnrow btnrow--2">
          <a class="btn btn--ghost" href="${routeUrl(coordsOf(a.id))}" target="_blank" rel="noopener">🧭 ルート</a>
          <button class="btn btn--ghost" data-open="${a.id}">ℹ️ くわしく</button>
        </div>
        <div class="hint">👇 乗ったら下の大きなボタン</div>
      </div></article>`;
  }

  if (p.type === 'anchor') {
    const x = p.anchor;
    const isShow = x.kind === 'show';
    const s = isShow ? showById[x.show] : null;
    const rest = x.restaurant ? restaurantById[x.restaurant] : null;
    const title = isShow ? `${x.title}へ！` : `${x.title}：${x.place}`;
    const img = isShow ? imgFor(x.show === 'fantasmic' ? 'fantasmic' : x.show === 'fireworks' ? 'fireworks' : 'cavalcade', { name: s.en, emoji: s.emoji, color: '#5b3f78' }) : foodImg(rest);
    const chips = isShow
      ? [['📍', s.venue.split('（')[0], ''], ['⏰', `${clock(x.start - x.claim)}〜場所取り`, 'warn']]
      : [['🍽', `${fmtDur(x.end - x.start)}確保`, 'good'], rest.mobile === 'yes' ? ['📱', 'モバイルオーダー可', 'good'] : rest.mobile === 'no' ? ['🪑', 'テーブル席', ''] : ['📱', 'MO要確認', '']];
    return `<article class="card next">
      <div class="next__photo">${img}<span class="next__stamp">${isShow ? 'SHOWTIME' : 'MEAL TIME'}</span>${(() => { const k = isShow ? (x.show) : 'food_' + rest.id; return R.photos[k] ? `<span class="next__credit">${esc(credit(k))}</span>` : ''; })()}</div>
      <div class="next__body">
        <div><div class="next__kicker">${isShow ? 'SHOW' : 'DINING'} · ${clock(x.start)}</div><h1 class="next__title">${esc(title)}</h1>${rest ? `<div class="next__en">${esc(rest.en)}</div>` : ''}</div>
        <div class="stats">
          <div class="stat"><div class="stat__k">${isShow ? '🎆 開演' : '🍽 開始'}</div><div class="stat__v">${clock(x.start)}</div></div>
          <div class="stat"><div class="stat__k">🚶 徒歩</div><div class="stat__v">${p.walk}<small>分</small></div><div class="stat__src"><span class="tag tag--ghost">目安</span></div></div>
          <div class="stat"><div class="stat__k">${isShow ? '⏰ 場所取り' : '⌛ 所要'}</div><div class="stat__v">${isShow ? clock(x.start - x.claim) : x.end - x.start + '<small>分</small>'}</div></div>
        </div>
        <div class="rchips">${chips.map(([i, t, k]) => `<span class="rchip ${k ? 'rchip--' + k : ''}"><i>${i}</i>${esc(t)}</span>`).join('')}</div>
        <div class="btnrow btnrow--2">
          <a class="btn btn--ghost" href="${routeUrl(x.pos)}" target="_blank" rel="noopener">🧭 ルート</a>
          <button class="btn btn--ghost" data-anchor-edit="${x.id}">✎ ${isShow ? '回を変える' : '時間・お店'}</button>
        </div>
        ${rest ? `<button class="linkbtn" data-open-food="${rest.id}">🍴 メニュー・料金</button>` : ''}
      </div></article>`;
  }

  const nearSnacks = RESTAURANTS.filter((x) => x.kind === 'sweets' || x.kind === 'snack')
    .map((x) => ({ x, w: walkMin(c.pos, coordsOf(x.id)) })).sort((a, b) => a.w - b.w).slice(0, 4);
  return `<article class="card next">
    <div class="next__photo">${imgFor('castle', { name: 'Free Time', emoji: '🏰', color: '#5b3f78' })}<span class="next__stamp">FREE TIME</span></div>
    <div class="next__body">
      <div><div class="next__kicker">おやつ・写真・お土産</div><h1 class="next__title">${next ? `${esc(next.title)}まで ${fmtDur(p.minutes)}` : '自由時間'}</h1></div>
      ${next ? `<div class="rchips"><span class="rchip rchip--warn"><i>🚶</i>${clock(r.leaveBy)}に移動開始</span><span class="rchip"><i>🎢</i>今から乗れる施設なし</span></div>` : ''}
      <div class="restgrid">${nearSnacks.map((n) => `<button class="rest" data-open-food="${n.x.id}"><span class="rest__e">${n.x.emoji}</span><span class="rest__n">${esc(n.x.ja)}</span><span class="rest__s">🚶${n.w}分</span></button>`).join('')}</div>
      <div class="rchips">${POPCORN.map((x) => `<span class="rchip rchip--hot"><i>${x.emoji}</i>${esc(x.ja)}バケット</span>`).join('')}</div>
    </div></article>`;
}

function renderLocCard(pos) {
  const on = S.gps && R.gpsPos;
  const icon = pos.src === 'gps' ? '📍' : pos.src === 'outside' ? '🚶' : pos.src === 'none' ? '❔' : '📌';
  return `<div class="card loc">
    <div class="loc__icon ${pos.src === 'gps' ? '' : 'is-off'}">${icon}</div>
    <div><div class="loc__title">${pos.src === 'gps' ? 'GPS使用中' : pos.src === 'outside' ? 'パークの外にいます' : pos.src === 'none' ? '現在地：未設定' : '現在地：推定'}</div>
      <div class="loc__sub">${esc(pos.label)}${pos.weak ? ' · 精度低め' : ''}${R.gpsErr ? `<br><span style="color:var(--bad)">${esc(R.gpsErr)}</span>` : ''}</div></div>
    <div class="loc__actions">
      ${on ? `<button class="btn btn--ghost btn--sm" data-act="gps-stop">GPSを止める</button>` : `<button class="btn btn--navy btn--sm" data-act="gps-start">📍 現在地を使う</button>`}
      <button class="btn btn--ghost btn--sm" data-act="pick-land">🗺 エリアを選ぶ</button>
    </div></div>`;
}

function renderDataCard() {
  const l = R.live;
  let main;
  if (R.liveStatus === 'loading') main = '⏳ 更新中…';
  else if (l?.ok) main = `${liveIsFresh() ? '🟢' : '🟡'} ${esc(l.sourceLabel)} · ${Math.round(liveAgeMin())}分前${l.stale ? ' · 最新取得失敗' : ''}`;
  else if (R.liveStatus === 'error') main = '🔴 取得失敗 → 推定値';
  else main = '⚪ 推定値';
  return `<div class="card datastat"><div>${main}<br><span style="font-size:11px;color:var(--muted)">${kindTag('live')} 外部提供　${kindTag('manual')} 入力　${kindTag('est')} 推定</span></div>
    <button class="btn btn--gold btn--sm ${R.liveStatus === 'loading' ? 'is-busy' : ''}" data-act="refresh" ${R.liveStatus === 'loading' ? 'disabled' : ''}>↻ 更新</button></div>`;
}

function footer() {
  return `<p class="footer">非公式の個人用ナビ · 待ち時間 ThemeParks.wiki / Queue-Times.com · 写真 Wikipedia</p>`;
}

// =====================================================================
// PLAN
// =====================================================================
const PLAN_EMOJI = { relax: '☕', balance: '🎡', rides: '🎢' };
function renderPlan() {
  const el = $('#view-plan');
  const c = ctx();
  const sim = simulateDay(c);
  const done = doneRides();
  const conflicts = anchorConflicts(c.anchors);
  let html = `<div class="plans">`;
  for (const p of Object.values(PLANS)) {
    html += `<button class="plancard ${S.plan === p.id ? 'is-active' : ''}" data-plan="${p.id}" type="button"><span class="plancard__emoji">${PLAN_EMOJI[p.id]}</span><span class="plancard__n">${p.ja}</span><span class="plancard__l">PLAN ${p.label}</span></button>`;
  }
  html += `</div>`;
  const meals = c.anchors.filter((a) => a.kind === 'meal').length;
  const shows = c.anchors.filter((a) => a.kind === 'show').length;
  html += `<div class="meters">
    <div class="meter-box"><b>🎢 ${done.length + sim.rides}</b><span>乗り物</span></div>
    <div class="meter-box"><b>★ ${2 - sim.missingMust.length}/2</b><span>SW必須</span></div>
    <div class="meter-box"><b>🍽 ${meals}</b><span>食事・休憩</span></div>
    <div class="meter-box"><b>🎆 ${shows}</b><span>ショー</span></div></div>`;
  if (sim.missingMust.length) html += `<div class="note note--bad"><span class="note__icon">⚠️</span><div><div class="note__t">${sim.missingMust.map((id) => esc(attractionById[id].short)).join('・')} が入りきらない</div><div class="note__s">休止中なら再開後に最優先で案内</div></div></div>`;
  if (conflicts.length) html += `<div class="note note--bad"><span class="note__icon">⚠️</span><div><div class="note__t">食事とショーが重なっています</div><div class="note__s">✎ から時間を調整</div></div></div>`;

  html += `<button class="btn btn--navy ${R.liveStatus === 'loading' ? 'is-busy' : ''}" data-act="replan" ${R.liveStatus === 'loading' ? 'disabled' : ''}>↻ 最新の待ち時間で組み直す</button>`;

  const doneIds = Object.keys(S.done).sort((a, b) => (S.doneMin[a] ?? 0) - (S.doneMin[b] ?? 0) || S.done[a] - S.done[b]);
  if (doneIds.length) {
    html += `<div class="h-section"><h2>✅ 完了したこと</h2><span class="sub">タップで未完了に戻せます</span></div><ol class="tl tl--done">`;
    for (const id of doneIds) {
      const a = attractionById[id];
      const em = a ? '🎢' : id.startsWith('meal:') ? (anchors().find((x) => x.id === id)?.emoji || '🍽') : (showById[id.slice(5)]?.emoji || '🎆');
      html += `<li class="tl__item tl__item--done"><span class="tl__time">${S.doneMin[id] != null ? clock(S.doneMin[id]) : '—'}</span><span class="tl__dot">✓</span>
        <div class="tl__card"><div class="tl__head"><div class="tl__name">${em} ${esc(doneName(id))}</div><button class="check is-done" data-done="${id}">✓ 完了</button></div></div></li>`;
    }
    html += `</ol>`;
  }

  html += `<div class="h-section"><h2>これからの予定</h2><span class="sub">${clock(Math.max(c.now, c.openMin))}〜 自動</span></div><ol class="tl">`;
  for (const it of sim.items) {
    if (it.type === 'free' && it.end - it.start < 10) continue;
    if (it.type === 'ride') {
      const a = it.a;
      html += `<li class="tl__item ${a.must ? 'tl__item--must' : ''}"><span class="tl__time">${clock(it.start)}</span><span class="tl__dot">${a.must ? '★' : '🎢'}</span>
        <div class="tl__card"><div class="tl__head"><button class="tl__name" data-open="${a.id}">${esc(a.short)}</button>
          <button class="check" data-done="${a.id}">✓ 乗った</button></div>
          <div class="tl__meta">${kindTag(it.waitKind)} ⏳${it.wait}分 · 🚶${it.walk}分 · 🏁${clock(it.end)}</div></div></li>`;
    } else if (it.type === 'meal' || it.type === 'show') {
      const x = it.anchor;
      html += `<li class="tl__item tl__item--${it.type}"><span class="tl__time">${clock(x.start)}</span><span class="tl__dot">${x.emoji}</span>
        <div class="tl__card"><div class="tl__head"><div class="tl__name">${esc(x.title)}${x.shifted ? ' <span class="tag tag--warn">↪ ずらしました</span>' : ''}</div><button class="check" data-done="${x.id}">✓ ${it.type === 'show' ? '観た' : '食べた'}</button></div>
          <div class="tl__meta">${x.place && it.type === 'meal' ? '🍴 ' + esc(x.place) + ' · ' : ''}${clock(x.start)}〜${clock(x.end)}${x.claim ? ` · <b style="color:var(--red-d)">⏰${clock(x.start - x.claim)}〜場所取り</b>` : ''}
          <button class="tag tag--gold" data-anchor-edit="${x.id}">✎ 変更</button></div></div></li>`;
    } else if (it.type === 'dropped') {
      const x = it.anchor;
      html += `<li class="tl__item tl__item--dropped"><span class="tl__time">${clock(it.start)}</span><span class="tl__dot">${x.emoji}</span>
        <div class="tl__card"><div class="tl__name" style="text-decoration:line-through">${esc(x.title)}</div><div class="tl__meta">★ 必須を優先して見送り</div></div></li>`;
    } else {
      html += `<li class="tl__item tl__item--free"><span class="tl__time">${clock(it.start)}</span><span class="tl__dot">☕</span>
        <div class="tl__card">📸 散策・お土産 ${fmtDur(it.end - it.start)}</div></li>`;
    }
  }
  html += `</ol>`;
  html += `<p class="footer">時刻・現在地・待ち時間・体験済みから毎回自動で組み直し</p>`;
  el.innerHTML = html;
  R.lastPlanIds = sim.items.map((i) => i.id).join(',');
}

// =====================================================================
// EXPLORE
// =====================================================================
function renderExplore() {
  const el = $('#view-explore');
  const tab = S.exploreTab;
  let html = `<div class="seg" role="tablist">
    <button class="${tab === 'rides' ? 'is-active' : ''}" data-xtab="rides">🎢 乗り物</button>
    <button class="${tab === 'food' ? 'is-active' : ''}" data-xtab="food">🍗 グルメ</button>
    <button class="${tab === 'halloween' ? 'is-active' : ''}" data-xtab="halloween">🎃 ハロウィン限定</button></div>`;
  const c = ctx();
  if (tab === 'rides') {
    const filters = [['all', 'すべて'], ['priority', '★ 必須・優先'], ['short', '30分以下'], ['near', '近い順'], ['todo', '未体験'], ['done', '体験済み'], ['down', '休止中'], ['japan', '日本にない']];
    html += `<div class="chips">${filters.map(([k, n]) => `<button class="chip ${S.exploreFilter === k ? 'is-active' : ''}" data-xf="${k}">${n}</button>`).join('')}</div>`;
    html += `<div class="sortrow"><span id="xcount"></span><label>並べ替え <select data-xsort>${[['reco', 'おすすめ'], ['wait', '待ち時間'], ['dist', '距離'], ['pop', '人気'], ['thrill', 'スリル']].map(([k, n]) => `<option value="${k}" ${S.exploreSort === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
    let list = ATTRACTIONS.map((a) => ({ a, w: waitInfo(a), walk: walkMin(c.pos, coordsOf(a.id)), d: c.pos ? distanceM(c.pos, coordsOf(a.id)) : null }));
    const f = S.exploreFilter;
    list = list.filter(({ a, w }) => f === 'all' || f === 'near'
      || (f === 'priority' && (a.must || (PRIORITY[a.id] || 0) >= 14))
      || (f === 'short' && w.wait != null && w.wait <= 30)
      || (f === 'todo' && !S.done[a.id]) || (f === 'done' && S.done[a.id])
      || (f === 'down' && w.status && w.status !== 'OPERATING' && c.now >= c.openMin)
      || (f === 'japan' && /日本未上陸|日本にない/.test(a.japan)));
    const sort = f === 'near' ? 'dist' : S.exploreSort;
    const reco = recommend(c);
    const rank = new Map([reco.primary?.a?.id, ...reco.alts.map((x) => x.a.id)].filter(Boolean).map((id, i) => [id, i]));
    list.sort((x, y) => {
      if (sort === 'wait') return (x.w.wait ?? 999) - (y.w.wait ?? 999);
      if (sort === 'dist') return (x.d ?? 1e9) - (y.d ?? 1e9);
      if (sort === 'pop') return y.a.pop - x.a.pop || (PRIORITY[y.a.id] || 0) - (PRIORITY[x.a.id] || 0);
      if (sort === 'thrill') return y.a.thrill - x.a.thrill;
      return (rank.get(x.a.id) ?? 99) - (rank.get(y.a.id) ?? 99) || (y.a.must - x.a.must) || (PRIORITY[y.a.id] || 0) - (PRIORITY[x.a.id] || 0);
    });
    html += `<div class="list">${list.map(({ a, w, walk }) => `
      <button class="card item" data-open="${a.id}" type="button">
        <div class="item__img">${rideImg(a)}</div>
        <div class="item__body">
          <div class="item__top"><div><div class="item__name">${a.must ? '★ ' : ''}${esc(a.ja)}</div>${S.done[a.id] ? '<span class="tag tag--live">✓ 完了</span>' : ''}<div class="item__en">${esc(a.en)}</div></div>
            <div class="item__wait">${w.wait == null ? `<span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止')}</span>` : `<b class="${waitClass(w.wait)}">${w.wait}<small>分</small></b><div>${kindTag(w.kind)}</div>`}</div></div>
          <div class="item__meta"><span>${esc(landById[a.land]?.ja)}</span>·<span>徒歩${walk}分</span>·<span>スリル ${stars(a.thrill)}</span></div>
          ${sparkSmall(a.id) ? `<div class="item__meta">${sparkSmall(a.id)}<span>今日の推移</span></div>` : ''}
          <div class="item__meta">${rank.has(a.id) ? '<span class="tag tag--gold">今おすすめ</span>' : ''}${/日本未上陸/.test(a.japan) ? '<span class="tag">日本未上陸</span>' : ''}${a.must ? '<span class="tag tag--must">必須</span>' : ''}</div>
        </div></button>`).join('') || '<div class="empty">該当するアトラクションはありません</div>'}</div>`;
    el.innerHTML = html;
    $('#xcount').textContent = `${list.length}件`;
    return;
  }
  if (tab === 'food') {
    const filters = [['all', 'すべて'], ['meal', '食事'], ['sweets', 'スイーツ'], ['snack', '軽食'], ['mobile', 'モバイルオーダー'], ['halloween', 'ハロウィン限定あり']];
    html += `<div class="chips">${filters.map(([k, n]) => `<button class="chip ${S.foodFilter === k ? 'is-active' : ''}" data-ff="${k}">${n}</button>`).join('')}</div>`;
    let list = RESTAURANTS.map((r) => ({ r, walk: walkMin(c.pos, coordsOf(r.id)), d: c.pos ? distanceM(c.pos, coordsOf(r.id)) : null }));
    const f = S.foodFilter;
    list = list.filter(({ r }) => f === 'all' || (f === 'meal' && (r.kind === 'meal' || r.kind === 'cafe')) || (f === 'sweets' && (r.kind === 'sweets' || r.kind === 'cafe')) || (f === 'snack' && r.kind === 'snack') || (f === 'mobile' && r.mobile === 'yes') || (f === 'halloween' && r.halloween.length));
    list.sort((x, y) => (x.d ?? 0) - (y.d ?? 0));
    html += `<div class="note note--info"><span class="note__icon">ℹ️</span><div>料金・モバイルオーダー対応・限定メニューは<b>事前調査の情報</b>です。当日の販売状況は公式アプリで確認してください。</div></div>`;
    html += `<div class="list">${list.map(({ r, walk }) => `
      <button class="card item" data-open-food="${r.id}" type="button">
        <div class="item__img">${foodImg(r)}</div>
        <div class="item__body">
          <div class="item__top"><div><div class="item__name">${r.emoji} ${esc(r.ja)}</div><div class="item__en">${esc(r.en)}</div></div></div>
          <div class="item__meta"><span>${esc(r.menu[0]?.name || '')}</span>${r.menu[0]?.price && r.menu[0].price !== '要確認' ? `<span>· ${esc(r.menu[0].price)}</span>` : ''}</div>
          <div class="item__meta"><span>${esc(landById[r.land]?.ja)}</span>·<span>徒歩${walk}分</span>${r.mobile === 'yes' ? '<span class="tag tag--live">モバイルオーダー</span>' : ''}${r.halloween.length ? '<span class="tag tag--warn">🎃 限定</span>' : ''}</div>
        </div></button>`).join('')}</div>`;
    el.innerHTML = html;
    return;
  }
  // halloween
  html += `<div class="note"><span class="note__icon">🎃</span><div><b>今日（10/31）はハロウィン期間の最終日。</b>「〜10/31」と報道された商品は今日が最後のチャンスかもしれません。在庫・販売は当日未確認です。</div></div>`;
  html += `<div class="h-section"><h2>ポップコーンバケット</h2></div><div class="list">${POPCORN.map((p) => `
    <div class="card card--pad" style="display:grid;grid-template-columns:72px 1fr;gap:12px;align-items:start"><div style="width:72px;height:72px;border-radius:14px;overflow:hidden;border:2px solid var(--navy)">${imgFor('popcorn', { name: '', emoji: p.emoji, color: '#e4574c' })}</div>
      <div><div class="item__name">${esc(p.ja)}</div><div class="item__en">${esc(p.en)}</div>
      <div style="font-size:13px;margin-top:6px"><b>価格：</b>${esc(p.price)}<br><b>販売場所：</b>${esc(p.where)}<br><span style="color:var(--muted)">${esc(p.note)}</span></div></div></div>`).join('')}</div>`;
  html += `<div class="h-section"><h2>ハロウィン限定フード</h2><span class="sub">2026年の報道ベース</span></div><div class="card">`;
  html += RESTAURANTS.filter((r) => r.halloween.length).flatMap((r) => r.halloween.map((h) => ({ r, h }))).map(({ r, h }, i) => `
    <button class="after" style="border:0;border-radius:0;background:transparent;width:100%;text-align:left;${i ? 'border-top:1px dashed var(--line-2)' : ''}" data-open-food="${r.id}">
      <span style="font-size:22px">${r.emoji}</span><div style="flex:1"><b>${esc(h.name)}</b><div style="font-size:12px;color:var(--muted)">${esc(r.ja)} · ${esc(h.note)}</div></div><span style="color:var(--muted)">›</span></button>`).join('');
  html += `</div><p class="footer">出典：Disney Parks Blog「Foodie Guide to Halloween」および各種報道（2026年8〜10月）。</p>`;
  el.innerHTML = html;
}

// =====================================================================
// SHOWS
// =====================================================================
function renderShows() {
  const el = $('#view-shows');
  const c = ctx();
  const an = c.anchors.filter((a) => a.kind === 'show' && !a.done && a.end > c.now);
  let html = '';
  if (an[0]) {
    const x = an[0];
    html += `<div class="countdown"><div><div class="countdown__k">NEXT SHOW</div><div class="countdown__n">${x.emoji} ${esc(x.title)} ${clock(x.start)}</div>
      <div style="font-size:12.5px;color:var(--mustard);margin-top:3px;font-weight:800">⏰ ${clock(x.start - x.claim)}〜場所取り</div></div>
      <div class="countdown__v">${fmtDur(x.start - c.now)}<small>開演まで</small></div></div>`;
  }
  const sp = S.prefs.shows;
  const on = (id) => sp[id]?.on ?? PLANS[S.plan].shows[id];
  if (on('fireworks') && on('fantasmic')) {
    const fw = c.anchors.find((a) => a.show === 'fireworks'), fm = c.anchors.find((a) => a.show === 'fantasmic');
    if (fw && fm) {
      const steps = fw.start < fm.start
        ? [['🌊', clock(fw.start - fw.claim), '川沿いへ'], ['🎆', clock(fw.start), '花火'], ['🧍', clock(fw.end), 'そのまま待つ'], ['🐉', clock(fm.start), 'ファンタズミック']]
        : [['🌊', clock(fm.start - fm.claim), '川沿いへ'], ['🐉', clock(fm.start), 'ファンタズミック'], ['🧍', clock(fm.end), 'そのまま'], ['🎆', clock(fw.start), '花火']];
      html += `<div class="card card--pad"><div class="h-section" style="margin:0 0 10px"><h2>🌙 夜の動線</h2><span class="sub">移動ほぼゼロ</span></div>
        <div class="flow">${steps.map(([i, t, s]) => `<div class="flow__step"><div class="flow__icon">${i}</div><div class="flow__t">${t}</div><div class="flow__s">${s}</div></div>`).join('')}</div>
        <details class="more" style="margin-top:8px"><summary>お城の映像も見たいときは？</summary><p>花火をお城前（ハブ）で見て、22:30回のファンタズミックへ移動（徒歩8〜10分＋混雑）。花火は「一部の夜のみ」なので当日の公式アプリで実施を確認。</p></details></div>`;
    }
  }
  for (const s of SHOWS) {
    const st = showTimesFor(s.id);
    const pick = c.anchors.find((a) => a.show === s.id);
    const srcTag = st.src === 'api' ? '<span class="tag tag--live">API公式</span>' : st.src === 'manual' ? '<span class="tag tag--manual">手入力</span>' : '<span class="tag tag--warn">要確認</span>';
    const apiStatus = R.live?.shows?.[s.id]?.status;
    html += `<article class="card show">
      <div class="show__head"><div class="show__img">${imgFor(s.id === 'fantasmic' ? 'fantasmic' : s.id === 'fireworks' ? 'fireworks' : 'cavalcade', { name: s.en, emoji: s.emoji, color: '#5b3f78' })}</div>
        <div class="show__body"><div class="show__name">${s.emoji} ${esc(s.short)}</div>
          <div class="times">${st.times.map((t) => `<button class="time ${pick && hhmm(pick.start) === t ? 'is-active' : ''} ${parseHHMM(t) + s.dur < c.now ? 'is-past' : ''}" data-pick-show="${s.id}" data-time="${t}">${t}</button>`).join('')}</div>
          <div class="item__meta">${srcTag}${apiStatus && apiStatus !== 'OPERATING' ? `<span class="tag tag--bad">${esc(STATUS_JA[apiStatus] || apiStatus)}</span>` : ''}<button class="linkbtn" data-edit-times="${s.id}">✎ 時刻修正</button></div></div></div>
      <div class="show__foot">
        <label class="switch">プランに入れる<input type="checkbox" data-show-toggle="${s.id}" ${on(s.id) ? 'checked' : ''}></label>
        <div class="show__row"><span>📍</span><span>${esc(s.venue)}</span></div>
        ${pick ? `<div class="show__row"><span>⏰</span><span>${clock(pick.start - pick.claim)}〜 場所取り（開演${pick.claim}分前）</span></div>` : ''}
        <details class="more"><summary>どんなショー？ どこで観る？</summary><p>${esc(s.desc)}</p><p>${esc(s.viewing)}</p></details>
      </div></article>`;
  }
  const others = R.live?.otherShows || [];
  if (others.length) {
    html += `<div class="h-section"><h2>その他のショー</h2><span class="sub">API</span></div><div class="card card--pad" style="font-size:13px;line-height:1.9">${others.slice(0, 12).map((o) => `<div><b>${esc(o.name)}</b> ${o.times.filter((t) => !t.date || t.date === TRIP.date).map((t) => `<span class="tag">${hhmm(t.start)}</span>`).join(' ') || '—'}</div>`).join('')}</div>`;
  }
  html += `<p class="footer">${'<span class="tag tag--live">API公式</span>'} ThemeParks.wiki経由の当日時刻 · ${'<span class="tag tag--warn">要確認</span>'} 事前情報</p>`;
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
  const d = c.pos ? Math.round(distanceM(c.pos, pos)) : null;
  const raw = R.live?.attractions?.[a.id];
  const later = [11, 14, 17, 20].map((h) => `${h}時 ${estimateWait(a, h * 60)}分`).join(' / ');
  openSheet(`
    <div class="sheet__hero">${rideImg(a)}${R.photos[a.id] ? `<a class="next__credit" href="${esc(R.photos[a.id].page)}" target="_blank" rel="noopener">${esc(credit(a.id))}</a>` : ''}</div>
    <div class="sheet__content">
      <div><div class="next__kicker">${esc(landById[a.land]?.en)}</div><h2 class="sheet__title" id="sheetTitle">${esc(a.ja)}</h2><div class="next__en">${esc(a.en)}</div></div>
      <div class="stats">
        <div class="stat"><div class="stat__k">待ち時間</div><div class="stat__v ${waitClass(w.wait)}">${w.wait == null ? '—' : w.wait + '<small>分</small>'}</div><div class="stat__src">${w.wait == null ? `<span class="tag tag--bad">${esc(STATUS_JA[w.status] || '休止')}</span>` : kindTag(w.kind)}</div></div>
        <div class="stat"><div class="stat__k">徒歩（目安）</div><div class="stat__v">${walk}<small>分</small></div><div class="stat__src"><span class="tag tag--ghost">${d != null ? `直線${d}m` : '位置未設定'}</span></div></div>
        <div class="stat"><div class="stat__k">スリル</div><div class="stat__v" style="font-size:18px;padding-top:6px">${stars(a.thrill)}</div><div class="stat__src"><span class="tag tag--ghost">人気 ${'★'.repeat(a.pop)}</span></div></div>
      </div>
      ${!av.ok ? `<div class="note note--bad"><span class="note__icon">⛔</span><div>${esc(av.reason)}${a.must ? '。必須なので予定からは外さず、再開したら最優先で案内します。' : '。'}</div></div>` : ''}
      <p class="para">${esc(a.desc)}</p>
      ${sparkBig(a)}
      <div class="box"><b>🇯🇵 日本との違い</b><br>${esc(a.japan)}</div>
      <div class="box"><b>💡 攻略メモ</b><br>${esc(a.tip)}</div>
      <dl class="kv">
        <dt>データ</dt><dd>${raw ? `${esc(R.live.sourceLabel)}：${esc(STATUS_JA[raw.status] || raw.status)}${raw.wait != null ? ` / ${raw.wait}分` : ''}${raw.lastUpdated ? `（${new Intl.DateTimeFormat('ja-JP', { timeZone: TRIP.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(raw.lastUpdated))}更新）` : ''}${liveIsFresh() ? '' : ' <span class="tag tag--warn">古い</span>'}` : '外部データなし（推定値）'}</dd>
        ${raw?.single != null ? `<dt>シングル</dt><dd>${raw.single}分（1人ずつ別々に乗る場合）</dd>` : ''}
        <dt>推定の傾向</dt><dd>${later}<br><span style="color:var(--muted);font-size:12px">※計画用の推定。実測ではありません</span></dd>
        <dt>所要</dt><dd>約${a.dur}分（乗車・乗り降り込み）</dd>
        <dt>位置</dt><dd>${pos.src === 'api' ? 'ThemeParks.wikiの座標' : '概略位置（APIの座標を取得できていません）'}</dd>
      </dl>
      <div class="box"><b>公式アプリの待ち時間を入力</b>（APIが古い/取れない時用・30分有効）
        <div class="formrow" style="margin-top:8px"><input type="number" inputmode="numeric" min="0" max="300" step="5" id="manualWait" placeholder="分" value="${S.manual[a.id] && Date.now() - S.manual[a.id].at < 30 * 60e3 ? S.manual[a.id].wait : ''}"><button class="btn btn--navy btn--sm" data-manual-save="${a.id}">保存</button>${S.manual[a.id] ? `<button class="btn btn--ghost btn--sm" data-manual-clear="${a.id}">消去</button>` : ''}</div></div>
      <div class="btnrow btnrow--2">
        <a class="btn btn--ghost" href="${routeUrl(pos)}" target="_blank" rel="noopener">🧭 ルート（Googleマップ）</a>
        ${S.done[a.id] ? `<button class="btn btn--mint" data-done="${a.id}">✓ 完了済み（${S.doneMin[a.id] != null ? clock(S.doneMin[a.id]) : ''}）</button>` : `<button class="btn btn--primary" data-done="${a.id}" data-close>✓ 乗り終わった</button>`}
      </div>
      ${a.must ? '' : `<button class="btn btn--ghost btn--sm" data-exclude="${a.id}" data-close>${S.excluded[a.id] ? '今日の候補に戻す' : '今日はパス（おすすめから外す）'}</button>`}
    </div>`);
}

function openFood(id) {
  const r = restaurantById[id];
  const c = ctx();
  const pos = coordsOf(r.id);
  const walk = walkMin(c.pos, pos);
  openSheet(`
    <div class="sheet__hero">${foodImg(r)}${R.photos['food_' + r.id] ? `<a class="next__credit" href="${esc(R.photos['food_' + r.id].page)}" target="_blank" rel="noopener">${esc(credit('food_' + r.id))}</a>` : ''}</div>
    <div class="sheet__content">
      <div><div class="next__kicker">${esc(landById[r.land]?.en)} · ${esc(r.style)}</div><h2 class="sheet__title" id="sheetTitle">${r.emoji} ${esc(r.ja)}</h2><div class="next__en">${esc(r.en)}</div></div>
      <p class="para">${esc(r.desc)}</p>
      <div><div class="h-section" style="margin:0 0 6px"><h2>人気メニュー</h2><span class="sub">料金は目安</span></div>
        <ul class="menu">${r.menu.map((m) => `<li><span>${esc(m.name)}<br><small style="color:var(--muted)">${esc(m.en)}</small></span><span>${esc(m.price)}</span></li>`).join('')}</ul></div>
      ${r.halloween.length ? `<div class="box"><b>🎃 2026ハロウィン限定（報道ベース・販売は当日未確認）</b><br>${r.halloween.map((h) => `・${esc(h.name)}<span style="color:var(--muted)">（${esc(h.note)}）</span>`).join('<br>')}</div>` : ''}
      <dl class="kv">
        <dt>距離</dt><dd>徒歩約${walk}分（目安）</dd>
        <dt>営業時間</dt><dd>${esc(r.hours)}</dd>
        <dt>モバイルオーダー</dt><dd>${r.mobile === 'yes' ? '対応（事前情報）' : r.mobile === 'no' ? '非対応（テーブルサービス）' : '不明（公式アプリで確認）'}</dd>
      </dl>
      <div class="btnrow btnrow--2">
        <a class="btn btn--ghost" href="${routeUrl(pos)}" target="_blank" rel="noopener">🧭 ルート</a>
        <a class="btn btn--navy" href="${esc(r.menuUrl)}" target="_blank" rel="noopener">公式メニュー ↗</a>
      </div>
    </div>`);
}

function mealCfg(mealId) {
  const base = PLANS[S.plan].meals.find((m) => m.id === mealId);
  const ov = S.prefs.mealOverrides[mealId] || {};
  return { base, ov, at: ov.at ?? base.at, rest: ov.restaurant || base.restaurant };
}
function openAnchorEdit(id) {
  if (id.startsWith('show:')) { closeSheet(); go('shows'); return; }
  const mealId = id.slice(5);
  const { base, ov, at, rest } = mealCfg(mealId);
  const opts = RESTAURANTS.filter((r) => (mealId === 'snack' ? true : r.kind === 'meal' || r.kind === 'cafe'));
  const c = ctx();
  openSheet(`<div class="sheet__content" style="padding-top:30px">
    <h2 class="sheet__title" id="sheetTitle">🍽 ${esc(base.ja)}</h2>
    <div class="stepper">
      <button data-meal-step="${mealId}" data-delta="-15">−15分</button>
      <div class="stepper__v">${clock(at)}<small>${base.dur}分確保</small></div>
      <button data-meal-step="${mealId}" data-delta="15">＋15分</button>
    </div>
    <div class="restgrid">${opts.map((r) => `<button class="rest ${r.id === rest ? 'is-active' : ''}" data-meal-rest="${mealId}" data-rest="${r.id}">
      <span class="rest__e">${r.emoji}</span><span class="rest__n">${esc(r.ja)}</span><span class="rest__s">🚶${walkMin(c.pos, coordsOf(r.id))}分${r.mobile === 'yes' ? ' · 📱MO' : ''}</span></button>`).join('')}</div>
    <div class="btnrow btnrow--2"><button class="btn btn--ghost" data-meal-off="${mealId}">${ov.off ? '↩ 予定に戻す' : '🚫 今日は省略'}</button><button class="btn btn--ghost" data-meal-reset="${mealId}">↺ 初期設定</button></div>
    <button class="btn btn--navy" data-close>✓ 完了</button>
  </div>`);
}

function openLandPicker() {
  const pos = position();
  openSheet(`<div class="sheet__content" style="padding-top:28px">
    <h2 class="sheet__title" id="sheetTitle">今どのあたり？</h2>
    <p class="para" style="font-size:13px;color:var(--muted)">GPSを使わない場合は、近いエリアを選ぶと距離・徒歩時間を計算します（90分間有効）。位置情報はこの端末の中だけで使い、外部へ送信しません。</p>
    <button class="btn btn--navy" data-act="gps-start" data-close>📍 GPSで現在地を使う</button>
    <div class="landgrid">${LANDS.map((l) => `<button style="--c:${l.color}" class="${S.land === l.id && pos.src === 'land' ? 'is-active' : ''}" data-land="${l.id}" data-close>${esc(l.ja)}</button>`).join('')}</div>
  </div>`);
}

function openSettings() {
  const h = hours();
  openSheet(`<div class="sheet__content" style="padding-top:28px">
    <h2 class="sheet__title" id="sheetTitle">設定・データについて</h2>
    <div class="box"><b>⏱ 待ち時間データ</b><br>
      取得元：ThemeParks.wiki（主）→ 失敗時 Queue-Times.com（予備）。サーバーで60秒キャッシュし、画面表示中は3分ごとに自動更新。15分以上古いデータは使わず「推定」に切り替えます。<br>
      LIVE＝外部提供値（公式アプリ由来の数値を中継）/ 手入力＝あなたが入力した実測 / 推定＝過去傾向による計画用の値。<br>
      状態：${R.live?.ok ? `${esc(R.live.sourceLabel)}・${Math.round(liveAgeMin())}分前` : '未取得'}${R.live?.errors?.length ? `<br><small>${esc(R.live.errors.join(' / '))}</small>` : ''}</div>
    <div class="box"><b>🕗 営業時間</b><br>${clock(h.open)}〜${clock(h.close)}（${h.src === 'api' ? 'ThemeParks.wikiの公式スケジュール' : 'あなたの予定値・APIで未確認'}）</div>
    <div class="box"><b>📍 位置情報</b><br>「現在地を使う」を押した時だけ取得し、この端末内でのみ計算に使います（サーバーへは送りません）。徒歩時間は「直線距離×1.4 ÷ 分速70m」の目安で、実際の園内ルートではありません。正確な道順は「ルート」からGoogleマップで確認してください。<br>座標：${R.meta?.coords && Object.keys(R.meta.coords).length ? `ThemeParks.wikiから${Object.keys(R.meta.coords).length}件取得` : '概略位置（API未取得）'}</div>
    <div class="box"><b>🧪 時刻シミュレーション（テスト用）</b><br>
      <div class="formrow" style="margin-top:6px"><input type="time" id="simAt" value="${S.sim ? hhmm(nowMin()).padStart(5, '0') : '10:00'}"><button class="btn btn--navy btn--sm" data-act="sim-set">この時刻で表示</button>${S.sim ? '<button class="btn btn--ghost btn--sm" data-act="sim-off">解除</button>' : ''}</div></div>
    <div class="box"><b>💾 保存データ</b><br>体験済み・プラン・設定はこの端末のブラウザ（localStorage）に保存されます。
      <div class="formrow" style="margin-top:6px"><button class="btn btn--ghost btn--sm" data-act="reset">記録をすべてリセット</button></div></div>
    <div class="box"><b>🔗 公式</b><br><a href="https://disneyland.disney.go.com/entertainment/disneyland/" target="_blank" rel="noopener">エンターテイメント・スケジュール ↗</a><br><a href="https://disneyland.disney.go.com/guest-services/mobile-order/" target="_blank" rel="noopener">モバイルオーダー ↗</a></div>
    <p class="footer">Powered by ThemeParks.wiki · Queue-Times.com · Wikipedia · © OpenStreetMap contributors<br>非公式の個人用ツールです。</p>
  </div>`);
}

// =====================================================================
// Router & events
// =====================================================================
let mapMod = null;
function go(tab) {
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
  else if (tab === 'shows') renderShows();
  else if (tab === 'map') renderMap();
}
async function renderMap() {
  const el = $('#view-map');
  if (!el.querySelector('#map')) {
    el.innerHTML = `<div class="mapwrap"><div id="map" role="application" aria-label="パークの地図"></div>
      <div class="mapbar">${[['all', 'すべて'], ['rides', '🎢 アトラクション'], ['food', '🍗 食事'], ['shows', '🎆 ショー']].map(([k, n]) => `<button class="chip ${S.mapFilter === k ? 'is-active' : ''}" data-mf="${k}">${n}</button>`).join('')}</div>
      <div class="mapfab"><button data-act="map-me" aria-label="現在地">📍</button><button data-act="map-fit" aria-label="パーク全体">🏰</button></div>
      <div class="card mapcard" id="mapcard"></div></div>`;
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
      coordsSrc: (() => { const n = Object.keys(R.meta?.coords || {}).filter((k) => attractionById[k]).length; return n >= 15 ? 'api' : n > 0 ? 'partial' : 'approx'; })(),
      onOpen: (type, id) => (type === 'ride' ? openAttraction(id) : openFood(id)),
    });
    const p = r.primary;
    const dest = p?.type === 'ride' ? { name: p.a.short, pos: coordsOf(p.a.id), wait: p.wait, kind: p.kind } : p?.type === 'anchor' ? { name: p.anchor.title + (p.anchor.place ? '・' + p.anchor.place : ''), pos: p.anchor.pos } : null;
    const me = position();
    $('#mapcard').innerHTML = dest ? `<div class="mapcard__t">次の目的地：${esc(dest.name)}</div>
      <div class="mapcard__s">${me.lat != null ? `直線${Math.round(distanceM(me, dest.pos))}m · 徒歩約${walkMin(me, dest.pos)}分（目安）` : '現在地未設定'}${dest.wait != null ? ` · 待ち${dest.wait}分（${KIND_LABEL[dest.kind]}）` : ''}<br>点線は直線です。実際の道順は「ルート」で確認。${mapMod.coordsNote()}</div>
      <div class="btnrow btnrow--2"><a class="btn btn--primary btn--sm" href="${routeUrl(dest.pos)}" target="_blank" rel="noopener">🧭 ルート</a>${S.gps ? '<button class="btn btn--ghost btn--sm" data-act="map-me">📍 現在地へ</button>' : '<button class="btn btn--navy btn--sm" data-act="gps-start">📍 現在地を使う</button>'}</div>` : '<div class="mapcard__s">目的地はありません</div>';
  } catch (e) {
    el.innerHTML = `<div class="note note--bad"><span class="note__icon">⚠️</span><div>地図を読み込めませんでした（${esc(e.message)}）。電波の良い場所で再度お試しください。</div></div>`;
  }
}

function renderAll() { renderClock(); renderStatus(); renderView(); }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-open]');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) return go(d.tab);
  if (d.tabGo) { closeSheet(); return go(d.tabGo); }
  if (d.open) return openAttraction(d.open);
  if (d.openFood) return openFood(d.openFood);
  if (d.done) return markDone(d.done);
  if (d.undo) return undoDone(d.undo);
  if (d.pin) {
    S.pin = { id: d.pin, until: nowMin() + 30 }; R.alerts = R.alerts.filter((x) => x.id !== d.pin); save();
    go('home'); return toast(`📌 ${attractionById[d.pin].short} を次の行き先にしました`, 'ok');
  }
  if (d.dismissAlert) { R.alerts = R.alerts.filter((x) => x.id !== d.dismissAlert); return renderHome(); }
  if (d.skip) { skipFor(d.skip); const el = $('#alts'); return; }
  if (d.plan) return setPlan(d.plan);
  if (d.xtab) { S.exploreTab = d.xtab; save(); return renderExplore(); }
  if (d.xf) { S.exploreFilter = d.xf; save(); return renderExplore(); }
  if (d.ff) { S.foodFilter = d.ff; save(); return renderExplore(); }
  if (d.mf) { S.mapFilter = d.mf; save(); document.querySelectorAll('[data-mf]').forEach((b) => b.classList.toggle('is-active', b.dataset.mf === d.mf)); return renderMap(); }
  if (d.land) { S.land = d.land; S.landAt = Date.now(); save(); renderAll(); return toast(`現在地を「${landById[d.land].ja}」に設定しました`, 'ok'); }
  if (d.exclude) {
    if (S.excluded[d.exclude]) delete S.excluded[d.exclude]; else S.excluded[d.exclude] = true;
    save(); renderAll(); return toast(S.excluded[d.exclude] ? 'おすすめから外しました' : '候補に戻しました');
  }
  if (d.anchorEdit) return openAnchorEdit(d.anchorEdit);
  if (d.pickShow) {
    S.prefs.shows[d.pickShow] = { ...(S.prefs.shows[d.pickShow] || {}), on: true, pick: d.time }; save(); renderAll();
    return toast(`${showById[d.pickShow].short} を ${d.time} の回にしました`, 'ok');
  }
  if (d.editTimes) {
    const s = showById[d.editTimes];
    const cur = showTimesFor(s.id).times.join(', ');
    return openSheet(`<div class="sheet__content" style="padding-top:28px"><h2 class="sheet__title" id="sheetTitle">${esc(s.short)} の時刻</h2>
      <p class="para" style="font-size:13px;color:var(--muted)">公式アプリのエンタメ情報を見て、カンマ区切りで入力してください（例：21:00, 22:30）。空にすると自動（API→事前情報）に戻ります。</p>
      <div class="formrow"><input type="text" id="showTimesIn" value="${esc(S.prefs.showTimes[s.id]?.join(', ') || '')}" placeholder="${esc(cur)}" style="flex:1"><button class="btn btn--navy btn--sm" data-save-times="${s.id}">保存</button></div></div>`);
  }
  if (d.saveTimes) {
    const v = $('#showTimesIn').value.split(/[,、\s]+/).map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x));
    if (v.length) S.prefs.showTimes[d.saveTimes] = v; else delete S.prefs.showTimes[d.saveTimes];
    save(); closeSheet(); renderAll(); return toast(v.length ? '時刻を保存して組み直しました' : '自動の時刻に戻しました', 'ok');
  }
  if (d.manualSave) {
    const v = Number($('#manualWait').value);
    if (!Number.isFinite(v) || v < 0 || v > 300 || $('#manualWait').value === '') return toast('0〜300の数字を入力してください', 'error');
    S.manual[d.manualSave] = { wait: Math.round(v), at: Date.now() }; save(); closeSheet(); renderAll();
    return toast(`手入力：${attractionById[d.manualSave].short} ${Math.round(v)}分（30分有効）`, 'ok');
  }
  if (d.manualClear) { delete S.manual[d.manualClear]; save(); closeSheet(); renderAll(); return toast('手入力を消去しました'); }
  if (d.mealStep) {
    const { at } = mealCfg(d.mealStep);
    const v = Math.min(21 * 60, Math.max(8 * 60, at + Number(d.delta)));
    S.prefs.mealOverrides[d.mealStep] = { ...(S.prefs.mealOverrides[d.mealStep] || {}), at: v }; save(); renderView();
    openAnchorEdit('meal:' + d.mealStep);
    return toast(`${clock(v)} に変更`, 'ok');
  }
  if (d.mealRest) {
    S.prefs.mealOverrides[d.mealRest] = { ...(S.prefs.mealOverrides[d.mealRest] || {}), restaurant: d.rest }; save(); renderView();
    openAnchorEdit('meal:' + d.mealRest);
    return toast(`${restaurantById[d.rest].emoji} ${restaurantById[d.rest].ja} に変更`, 'ok');
  }
  if (d.mealSave) {
    const at = parseHHMM($('#mealAt').value); const rest = $('#mealRest').value;
    S.prefs.mealOverrides[d.mealSave] = { ...(S.prefs.mealOverrides[d.mealSave] || {}), at, restaurant: rest }; save(); closeSheet(); renderAll();
    return toast(`${restaurantById[rest].ja} ${hhmm(at)} に変更しました`, 'ok');
  }
  if (d.mealOff) {
    const o = S.prefs.mealOverrides[d.mealOff] = { ...(S.prefs.mealOverrides[d.mealOff] || {}) }; o.off = !o.off; save(); closeSheet(); renderAll();
    return toast(o.off ? '今日は省略にしました' : '予定に戻しました');
  }
  if (d.mealReset) { delete S.prefs.mealOverrides[d.mealReset]; save(); closeSheet(); renderAll(); return toast('初期設定に戻しました'); }
  switch (d.act) {
    case 'refresh': return fetchLive({ manual: true });
    case 'a2hs-off': S.a2hsDismissed = true; save(); return renderHome();
    case 'replan': {
      const before = R.lastPlanIds;
      await fetchLive({ manual: false });
      renderPlan();
      const changed = before !== R.lastPlanIds;
      return toast(R.liveStatus === 'error' ? '待ち時間を取得できず、推定値で組み直しました' : changed ? '最新の待ち時間で予定を組み直しました' : '組み直しました（予定に変更はありません）', R.liveStatus === 'error' ? 'error' : 'ok');
    }
    case 'gps-start': return startGPS(true);
    case 'gps-stop': return stopGPS();
    case 'pick-land': return openLandPicker();
    case 'sim-set': { const m = parseHHMM($('#simAt').value); S.sim = { base: m, setAt: Date.now() }; save(); closeSheet(); renderAll(); return toast(`${hhmm(m)} として表示しています`, 'ok'); }
    case 'sim-off': S.sim = null; save(); closeSheet(); renderAll(); return toast('現在時刻に戻しました');
    case 'reset':
      if (!confirm('体験済み・設定をすべてリセットしますか？')) return;
      S = structuredClone(defaults); save(); closeSheet(); renderAll(); return toast('リセットしました');
    case 'map-me':
      if (!S.gps) return startGPS(true);
      return mapMod?.locate(R.gpsPos);
    case 'map-fit': return mapMod?.fit();
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.xsort !== undefined) { S.exploreSort = t.value; save(); renderExplore(); }
  if (t.dataset.showToggle) {
    const id = t.dataset.showToggle;
    S.prefs.shows[id] = { ...(S.prefs.shows[id] || {}), on: t.checked }; save(); renderAll();
    toast(`${showById[id].short} を${t.checked ? 'プランに追加' : 'プランから外し'}ました`, 'ok');
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
    renderAll();
    if (Date.now() - R.liveReceivedAt > 2 * 60e3) fetchLive();
  }
});
// Resume GPS automatically only if the user enabled it before AND the browser already granted permission.
if (S.gps && navigator.permissions?.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') startGPS(false); else { S.gps = false; save(); } }).catch(() => {});
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.__dlnavi = { S, R, ctx, recommend, simulateDay };

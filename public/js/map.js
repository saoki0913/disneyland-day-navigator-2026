// Lazy-loaded Leaflet map (self-hosted Leaflet, OpenStreetMap tiles).
//
// Markers are created once and then updated in place (icon / position / popup) instead of
// being thrown away and re-added on every refresh. Updates that arrive while the user is
// panning or zooming are deferred until the gesture ends — re-adding markers during a
// Leaflet zoom animation could leave them hidden or mispositioned ("disappearing" pins).
let L = null, map = null, coordsSrc = 'approx', leafletP = null;
let markers = new Map(); // key -> { m, html, lat, lon, popup }
let me = null;           // { dot, ring }
let line = null;
let busy = false, busyAt = 0, pending = null;
const PARK_BOUNDS = [[33.8095, -117.9248], [33.8168, -117.9160]];
const FIT_PAD = { paddingTopLeft: [0, 50], paddingBottomRight: [0, 70] };

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  // Cache the promise: concurrent first draws must not inject Leaflet twice
  // (two Leaflet instances mixing markers on one map breaks rendering).
  if (leafletP) return leafletP;
  const css = new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/vendor/leaflet/leaflet.css';
    l.onload = resolve; l.onerror = () => reject(new Error('地図スタイルの読み込みに失敗'));
    document.head.appendChild(l);
  });
  const js = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Leafletの読み込みに失敗'));
    document.head.appendChild(s);
  });
  leafletP = Promise.all([css, js]).then(() => window.L).catch((e) => { leafletP = null; throw e; });
  return leafletP;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (w) => (w == null ? 'is-off' : w <= 20 ? 'is-good' : w <= 50 ? 'is-mid' : 'is-bad');
const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

export function coordsNote() {
  return coordsSrc === 'api' ? '' : ' · 位置は概略';
}

function ensureMap(el) {
  if (map && map.getContainer() === el) return;
  if (map) { try { map.remove(); } catch { /* detached */ } }
  markers = new Map(); me = null; line = null; busy = false; pending = null;
  map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 14, maxZoom: 19, zoomSnap: 0.25 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.fitBounds(PARK_BOUNDS);
  map.on('movestart zoomstart', () => { busy = true; busyAt = Date.now(); });
  map.on('moveend zoomend', () => {
    busy = false;
    if (pending) { const o = pending; pending = null; apply(o); }
  });
  setTimeout(() => { if (el.offsetWidth) { map.invalidateSize(); map.fitBounds(PARK_BOUNDS, FIT_PAD); } }, 150);
  window.__map = map;
}

export async function draw(opts) {
  L = await loadLeaflet();
  const el = document.getElementById('map');
  if (!el) return;
  ensureMap(el);
  if (el.offsetWidth) map.invalidateSize({ pan: false });
  // Safety: never hold updates for more than a few seconds even if an end event got lost.
  if (busy && Date.now() - busyAt < 4000) { pending = opts; return; }
  busy = false; pending = null;
  apply(opts);
}

// Create or update one marker. Only touches the DOM when something actually changed.
function upsert(seen, key, pos, html, size, popup, extra = {}) {
  seen.add(key);
  const cur = markers.get(key);
  if (cur) {
    if (cur.lat !== pos.lat || cur.lon !== pos.lon) { cur.m.setLatLng([pos.lat, pos.lon]); cur.lat = pos.lat; cur.lon = pos.lon; }
    if (cur.html !== html) {
      cur.m.setIcon(L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }));
      cur.html = html;
    }
    if (cur.z !== (extra.z || 0)) { cur.m.setZIndexOffset(extra.z || 0); cur.z = extra.z || 0; }
    if (cur.popup !== popup) { cur.m.setPopupContent(popup); cur.popup = popup; }
    return;
  }
  const m = L.marker([pos.lat, pos.lon], {
    icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    zIndexOffset: extra.z || 0, title: extra.title || '',
  }).addTo(map).bindPopup(popup);
  markers.set(key, { m, html, lat: pos.lat, lon: pos.lon, popup, z: extra.z || 0 });
}

function apply(opts) {
  coordsSrc = opts.coordsSrc;
  const f = opts.filter;
  const seen = new Set();
  let nextPos = null;
  if (f === 'all' || f === 'rides') {
    for (const { a, pos, w, done } of opts.rides) {
      if (!valid(pos)) continue;
      const isNext = a.id === opts.nextId;
      if (isNext) nextPos = pos;
      const label = done ? '済' : w.wait == null ? '休' : w.wait;
      const html = `<div class="mk mk--ride ${done ? 'is-done' : cls(w.wait)} ${isNext ? 'is-next' : ''}">${label}</div>`;
      const popup = `<b>${esc(a.ja)}</b><br>${w.wait == null ? '休止中' : `待ち${w.wait}分（${w.kind === 'live' ? 'LIVE' : w.kind === 'manual' ? '手入力' : '推定'}）`}${done ? ' · 体験済み' : ''}<br><button class="linkbtn" data-open="${a.id}">くわしく</button>`;
      upsert(seen, 'r:' + a.id, pos, html, isNext ? 38 : 30, popup, { z: isNext ? 1000 : 0, title: a.short });
    }
  }
  if (f === 'all' || f === 'food') {
    for (const { r, pos } of opts.food) {
      if (!valid(pos)) continue;
      const isT = opts.target?.id === r.id;
      if (isT) nextPos = pos;
      upsert(seen, 'f:' + r.id, pos, `<div class="mk mk--food ${isT ? 'is-target' : ''}">${opts.icons?.food || ''}</div>`, isT ? 32 : 24,
        `<b>${esc(r.ja)}</b><br>${esc(r.menu[0]?.name || '')}<br><button class="linkbtn" data-open-food="${r.id}">くわしく</button>`, { title: r.ja, z: isT ? 1000 : 0 });
    }
  }
  if (f === 'all' || f === 'shows') {
    for (const { s, pos } of opts.shows) {
      if (!valid(pos)) continue;
      upsert(seen, 's:' + s.id, pos, `<div class="mk mk--show">${opts.icons?.show || ''}</div>`, 24,
        `<b>${esc(s.ja)}</b><br>${esc(s.venue)}<br><button class="linkbtn" data-open-show="${s.id}">くわしく</button>`, { title: s.short });
    }
  }
  for (const [key, cur] of markers) if (!seen.has(key)) { cur.m.remove(); markers.delete(key); }

  setMe(opts.gps);

  // straight dotted line from the current position to the next destination
  const from = opts.pos?.lat != null ? opts.pos : null;
  if (from && nextPos) {
    const ll = [[from.lat, from.lon], [nextPos.lat, nextPos.lon]];
    if (line) line.setLatLngs(ll);
    else line = L.polyline(ll, { color: '#c8372d', weight: 3, dashArray: '6 8', opacity: 0.9, interactive: false }).addTo(map);
  } else if (line) { line.remove(); line = null; }
}

// Blue "you are here" dot + accuracy circle. Cheap enough to call on every GPS fix.
export function setMe(g) {
  if (!map || !L) return;
  if (!valid(g)) {
    if (me) { me.dot.remove(); me.ring.remove(); me = null; }
    return;
  }
  const ll = [g.lat, g.lon], r = Math.min(g.acc || 30, 300);
  if (me) { me.dot.setLatLng(ll); me.ring.setLatLng(ll); me.ring.setRadius(r); return; }
  me = {
    ring: L.circle(ll, { radius: r, color: '#2b7bf3', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map),
    dot: L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="mk mk--me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, title: '現在地', keyboard: false }).addTo(map),
  };
}
export function locate(g) { if (map && valid(g)) map.setView([g.lat, g.lon], Math.max(map.getZoom(), 17.5)); }
// Show every given point (e.g. me + the shop) with room for the top chips and bottom card.
export function fitTo(points) {
  const pts = points.filter(valid).map((p) => [p.lat, p.lon]);
  if (!map || !pts.length) return;
  if (pts.length === 1) return map.setView(pts[0], Math.max(map.getZoom(), 17));
  map.fitBounds(pts, { paddingTopLeft: [40, 70], paddingBottomRight: [60, 110], maxZoom: 18 });
}
export function fit() { if (map) map.fitBounds(PARK_BOUNDS, FIT_PAD); }

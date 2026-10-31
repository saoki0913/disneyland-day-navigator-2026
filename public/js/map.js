// Lazy-loaded Leaflet map (self-hosted Leaflet, OpenStreetMap tiles).
let L = null, map = null, layer = null, meLayer = null, lineLayer = null, lastFitted = false, coordsSrc = 'approx';
let lastMarkerKey = null, cachedNextPos = null;
const PARK_BOUNDS = [[33.8095, -117.9248], [33.8168, -117.9160]];

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
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
  return Promise.all([css, js]).then(() => window.L);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (w) => (w == null ? 'is-off' : w <= 20 ? 'is-good' : w <= 50 ? 'is-mid' : 'is-bad');

export function coordsNote() {
  return coordsSrc === 'api' ? '' : ' · 位置は概略';
}

export async function draw(opts) {
  L = await loadLeaflet();
  coordsSrc = opts.coordsSrc;
  const el = document.getElementById('map');
  const newMap = !map || map.getContainer() !== el;
  if (newMap) {
    lastMarkerKey = null; cachedNextPos = null;
    map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 14, maxZoom: 19, zoomSnap: 0.25 });
    map.setView([33.8125, -117.9200], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.fitBounds(PARK_BOUNDS);
    lastFitted = false;
  }
  window.__map = map;
  if (newMap) {
    map.invalidateSize();
    if (!lastFitted) { map.fitBounds(PARK_BOUNDS); lastFitted = true; }
    setTimeout(() => { if (map.getContainer() === el) { map.invalidateSize(); map.fitBounds(PARK_BOUNDS, { paddingTopLeft: [0, 50], paddingBottomRight: [0, 70] }); } }, 150);
  }
  // Rebuild ride markers only if the displayed data changed, not when GPS jitters.
  const markerKey = JSON.stringify([
    opts.filter, opts.nextId, opts.coordsSrc,
    opts.rides.map(({ a, pos, w, done }) => [a.id, pos?.lat, pos?.lon, w.wait, w.kind, done]),
    opts.food.map(({ r, pos }) => [r.id, pos?.lat, pos?.lon]),
    opts.shows.map(({ s, pos }) => [s.id, pos?.lat, pos?.lon]),
  ]);
  let nextPos = cachedNextPos;
  if (newMap || markerKey !== lastMarkerKey) {
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    const f = opts.filter;
    nextPos = null;
  if (f === 'all' || f === 'rides') {
    for (const { a, pos, w, done } of opts.rides) {
      if (!pos) continue;
      const isNext = a.id === opts.nextId;
      if (isNext) nextPos = pos;
      const label = done ? '済' : w.wait == null ? '休' : w.wait;
      const icon = L.divIcon({ className: '', html: `<div class="mk mk--ride ${done ? 'is-done' : cls(w.wait)} ${isNext ? 'is-next' : ''}">${label}</div>`, iconSize: isNext ? [38, 38] : [30, 30], iconAnchor: isNext ? [19, 19] : [15, 15] });
      const m = L.marker([pos.lat, pos.lon], { icon, zIndexOffset: isNext ? 1000 : 0, title: a.short }).addTo(layer);
      m.bindPopup(`<b>${esc(a.ja)}</b><br>${w.wait == null ? '休止中' : `待ち${w.wait}分（${w.kind === 'live' ? 'LIVE' : w.kind === 'manual' ? '手入力' : '推定'}）`}${done ? ' · 体験済み' : ''}<br><button class="linkbtn" data-open="${a.id}">くわしく</button>`);
    }
  }
  if (f === 'all' || f === 'food') {
    for (const { r, pos } of opts.food) {
      if (!pos) continue;
      const icon = L.divIcon({ className: '', html: `<div class="mk mk--food">${opts.icons?.food || ''}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([pos.lat, pos.lon], { icon, title: r.ja }).addTo(layer)
        .bindPopup(`<b>${esc(r.ja)}</b><br>${esc(r.menu[0]?.name || '')}<br><button class="linkbtn" data-open-food="${r.id}">くわしく</button>`);
    }
  }
  if (f === 'all' || f === 'shows') {
    for (const { s, pos } of opts.shows) {
      const icon = L.divIcon({ className: '', html: `<div class="mk mk--show">${opts.icons?.show || ''}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([pos.lat, pos.lon], { icon, title: s.short }).addTo(layer).bindPopup(`<b>${esc(s.ja)}</b><br>${esc(s.venue)}<br><button class="linkbtn" data-open-show="${s.id}">くわしく</button>`);
    }
  }
    cachedNextPos = nextPos;
    lastMarkerKey = markerKey;
  }
  // me + straight line to next
  if (meLayer) meLayer.remove();
  if (lineLayer) lineLayer.remove();
  const me = opts.gps;
  if (me) {
    meLayer = L.layerGroup([
      L.circle([me.lat, me.lon], { radius: Math.min(me.acc, 300), color: '#2b7bf3', weight: 1, fillOpacity: 0.08 }),
      L.marker([me.lat, me.lon], { icon: L.divIcon({ className: '', html: '<div class="mk mk--me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, title: '現在地' }),
    ]).addTo(map);
  }
  const from = opts.pos?.lat != null ? opts.pos : null;
  if (from && nextPos) {
    lineLayer = L.polyline([[from.lat, from.lon], [nextPos.lat, nextPos.lon]], { color: '#c8372d', weight: 3, dashArray: '6 8', opacity: 0.9 }).addTo(map);
  }
}
export function locate(g) { if (map && g) map.setView([g.lat, g.lon], 18); }
export function fit() { if (map) map.fitBounds(PARK_BOUNDS, { paddingTopLeft: [0, 50], paddingBottomRight: [0, 70] }); }

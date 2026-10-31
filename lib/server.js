// Shared server logic for the Cloudflare Pages Functions in /functions/api.
// Upstreams:
//   ThemeParks.wiki  https://api.themeparks.wiki/v1  (primary: waits, status, showtimes, coords, hours)
//   Queue-Times.com  https://queue-times.com/parks/16/queue_times.json (fallback: waits only)
//   Wikipedia REST   https://en.wikipedia.org/api/rest_v1/page/summary/{title} (photos)
// Every upstream response is cached at the edge so that phones polling us never
// multiply into upstream traffic (≈1 upstream call / minute at most for waits).
import { ATTRACTIONS, RESTAURANTS, SHOWS, PARK_ID_TPW, PARK_ID_QT, TRIP } from '../public/js/data.js';

const UA = 'dl-navi-1031 (personal trip planner; contact via GitHub saoki0913)';
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export function matchId(name, list) {
  const n = norm(name);
  for (const item of list) if (item.match.some((m) => n.includes(m))) return item.id;
  return null;
}

// "2026-10-31T21:00:00-07:00" → minutes since local midnight in park tz.
export function localMinutes(iso, tz = TRIP.tz) {
  if (!iso) return null;
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (m && /[+-]\d{2}:\d{2}$/.test(iso)) return Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  return h * 60 + Number(parts.find((p) => p.type === 'minute').value);
}
export function localDate(iso, tz = TRIP.tz) {
  if (!iso) return null;
  if (/[+-]\d{2}:\d{2}$/.test(iso)) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(iso));
}

export function normalizeTPWLive(json) {
  const attractions = {}, shows = {}, otherShows = [];
  let matched = 0;
  for (const rec of json?.liveData || []) {
    const type = rec.entityType;
    if (type === 'ATTRACTION') {
      const id = matchId(rec.name, ATTRACTIONS);
      if (!id) continue;
      const w = rec.queue?.STANDBY?.waitTime;
      const entry = {
        name: rec.name,
        status: rec.status || 'UNKNOWN',
        wait: Number.isFinite(w) ? w : null,
        lastUpdated: rec.lastUpdated || null,
        single: Number.isFinite(rec.queue?.SINGLE_RIDER?.waitTime) ? rec.queue.SINGLE_RIDER.waitTime : null,
      };
      // Prefer the record with a usable wait when several match (e.g. railroad stations).
      if (!attractions[id] || (attractions[id].wait == null && entry.wait != null)) {
        if (!attractions[id]) matched++;
        attractions[id] = entry;
      }
    } else if (type === 'SHOW') {
      const times = (rec.showtimes || [])
        .map((t) => ({ start: localMinutes(t.startTime), end: localMinutes(t.endTime), date: localDate(t.startTime), type: t.type || null }))
        .filter((t) => t.start != null);
      const id = matchId(rec.name, SHOWS);
      if (id) {
        shows[id] = { name: rec.name, status: rec.status || null, times, lastUpdated: rec.lastUpdated || null };
      } else if (times.length) {
        otherShows.push({ name: rec.name, status: rec.status || null, times });
      }
    }
  }
  return { attractions, shows, otherShows, matched };
}

export function normalizeQT(json) {
  const attractions = {};
  let matched = 0;
  const rides = [...(json?.rides || []), ...(json?.lands || []).flatMap((l) => l.rides || [])];
  for (const r of rides) {
    const id = matchId(r.name, ATTRACTIONS);
    if (!id || attractions[id]) continue;
    matched++;
    attractions[id] = {
      name: r.name,
      // Queue-Times only exposes open/closed: a closed ride may be down OR closed for the day.
      status: r.is_open ? 'OPERATING' : 'CLOSED',
      wait: r.is_open && Number.isFinite(r.wait_time) ? r.wait_time : null,
      lastUpdated: r.last_updated || null,
      single: null,
    };
  }
  return { attractions, shows: {}, otherShows: [], matched };
}

export function normalizeChildren(json) {
  const coords = {};
  for (const c of json?.children || []) {
    const lat = Number(c.location?.latitude), lon = Number(c.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // sanity box around Disneyland Park
    if (lat < 33.805 || lat > 33.82 || lon < -117.93 || lon > -117.91) continue;
    let id = null;
    if (c.entityType === 'ATTRACTION') id = matchId(c.name, ATTRACTIONS);
    else if (c.entityType === 'RESTAURANT') id = matchId(c.name, RESTAURANTS);
    else if (c.entityType === 'SHOW') id = matchId(c.name, SHOWS);
    if (id && !coords[id]) coords[id] = { lat, lon, name: c.name };
  }
  return coords;
}

export function normalizeSchedule(json, date = TRIP.date) {
  const out = { date, operating: null, extra: [] };
  for (const s of json?.schedule || []) {
    if (s.date !== date) continue;
    const e = { type: s.type, open: localMinutes(s.openingTime), close: localMinutes(s.closingTime), description: s.description || null };
    if (s.type === 'OPERATING' && !out.operating) out.operating = e;
    else out.extra.push(e);
  }
  return out;
}

// ---------- fetch + edge cache helpers ----------
async function fetchJSON(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${new URL(url).host} timeout` : e.message);
  } finally {
    clearTimeout(t);
  }
}

const cacheKey = (origin, name) => new Request(`${origin}/__edge-cache/${name}`);
async function cacheGet(origin, name) {
  try {
    const hit = await caches.default.match(cacheKey(origin, name));
    return hit ? await hit.json() : null;
  } catch { return null; }
}
async function cachePut(origin, name, data, ttl, waitUntil) {
  try {
    const p = caches.default.put(cacheKey(origin, name), new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    }));
    waitUntil ? waitUntil(p) : await p;
  } catch { /* cache is best-effort */ }
}

export function json(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

const LIVE_TTL = 60;          // seconds a fresh upstream result is reused for everyone
const LAST_GOOD_TTL = 6 * 3600;

export async function handleLive(ctx) {
  const origin = new URL(ctx.request.url).origin;
  const cached = await cacheGet(origin, 'live-v1');
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < LIVE_TTL * 1000) {
    return json({ ...cached, cache: 'HIT' });
  }
  const errors = [];
  let result = null;
  try {
    const j = await fetchJSON(`https://api.themeparks.wiki/v1/entity/${PARK_ID_TPW}/live`);
    const n = normalizeTPWLive(j);
    if (n.matched >= 5) result = { ...n, source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki' };
    else errors.push(`themeparks.wiki: 一致した施設が少ない (${n.matched})`);
  } catch (e) { errors.push('themeparks.wiki: ' + e.message); }

  if (!result) {
    try {
      const j = await fetchJSON(`https://queue-times.com/parks/${PARK_ID_QT}/queue_times.json`);
      const n = normalizeQT(j);
      if (n.matched >= 5) result = { ...n, source: 'queue-times.com', sourceLabel: 'Queue-Times.com' };
      else errors.push(`queue-times.com: 一致した施設が少ない (${n.matched})`);
    } catch (e) { errors.push('queue-times.com: ' + e.message); }
  }

  if (result) {
    const data = { ok: true, ...result, fetchedAt: new Date().toISOString(), errors };
    await cachePut(origin, 'live-v1', data, LIVE_TTL, ctx.waitUntil?.bind(ctx));
    await cachePut(origin, 'live-last-good', data, LAST_GOOD_TTL, ctx.waitUntil?.bind(ctx));
    return json({ ...data, cache: 'MISS' });
  }
  const last = await cacheGet(origin, 'live-last-good');
  if (last) return json({ ...last, ok: true, stale: true, errors, cache: 'STALE' });
  return json({ ok: false, errors, fetchedAt: new Date().toISOString() }, 502);
}

export async function handleMeta(ctx) {
  const origin = new URL(ctx.request.url).origin;
  const cached = await cacheGet(origin, 'meta-v1');
  if (cached) return json({ ...cached, cache: 'HIT' }, 200, 600);
  const errors = [];
  let coords = {}, schedule = null;
  const [c, s] = await Promise.allSettled([
    fetchJSON(`https://api.themeparks.wiki/v1/entity/${PARK_ID_TPW}/children`, 10000),
    fetchJSON(`https://api.themeparks.wiki/v1/entity/${PARK_ID_TPW}/schedule`, 10000),
  ]);
  if (c.status === 'fulfilled') coords = normalizeChildren(c.value); else errors.push('children: ' + c.reason.message);
  if (s.status === 'fulfilled') schedule = normalizeSchedule(s.value); else errors.push('schedule: ' + s.reason.message);
  const data = { ok: !errors.length || Object.keys(coords).length > 0 || !!schedule, coords, schedule, fetchedAt: new Date().toISOString(), source: 'themeparks.wiki', errors };
  if (data.ok) await cachePut(origin, 'meta-v1', data, errors.length ? 900 : 6 * 3600, ctx.waitUntil?.bind(ctx));
  return json(data, data.ok ? 200 : 502, data.ok ? 600 : 0);
}

// Wikipedia article → lead image. Titles are in data.js (`wiki`).
const EXTRA_PHOTOS = {
  castle: 'Sleeping_Beauty_Castle', fantasmic: 'Fantasmic!', fireworks: 'Halloween_Screams', cavalcade: 'Main_Street,_U.S.A.',
  galaxy: "Star_Wars:_Galaxy's_Edge", park: 'Disneyland',
  // Generic dish photos (labelled as "イメージ" in the UI — not the park's actual food)
  food_plazainn: 'Fried_chicken', food_tianas: 'Gumbo', food_mintjulep: 'Beignet', food_tropical: 'Dole_Whip',
  food_redwagon: 'Corn_dog', food_harbour: 'Clam_chowder', food_gibson: 'Sundae', food_galactic: 'Hamburger',
  food_bengal: 'Kebab', food_jolly: 'Cheese_sandwich', food_hungrybear: 'Barbecue', food_goldenhorseshoe: 'Apple_pie',
  food_carnation: 'Diner', food_dockingbay: 'Black_Spire_Outpost', food_ronto: 'Pita',
};
export async function handlePhotos(ctx) {
  const origin = new URL(ctx.request.url).origin;
  const cached = await cacheGet(origin, 'photos-v1');
  if (cached) return json({ ...cached, cache: 'HIT' }, 200, 86400);
  const titles = { ...Object.fromEntries(ATTRACTIONS.filter((a) => a.wiki).map((a) => [a.id, a.wiki])), ...EXTRA_PHOTOS };
  const photos = {};
  const errors = [];
  await Promise.all(Object.entries(titles).map(async ([id, title]) => {
    try {
      const j = await fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 8000);
      const big = (j.originalimage?.width || 0) >= 700 && /\/\d+px-/.test(j.thumbnail?.source || '');
      const img = big ? j.thumbnail.source.replace(/\/\d+px-/, '/640px-') : j.thumbnail?.source;
      if (img) photos[id] = { src: img, page: j.content_urls?.mobile?.page || j.content_urls?.desktop?.page, title: j.title };
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }));
  const data = { ok: Object.keys(photos).length > 0, photos, source: 'Wikipedia', fetchedAt: new Date().toISOString(), errors };
  if (data.ok) await cachePut(origin, 'photos-v1', data, errors.length > 5 ? 3600 : 7 * 86400, ctx.waitUntil?.bind(ctx));
  return json(data, data.ok ? 200 : 502, data.ok ? 3600 : 0);
}

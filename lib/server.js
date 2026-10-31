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

// ---------------------------------------------------------------------------
// Real photos from Wikimedia Commons (freely licensed), searched at runtime on the
// deployed server and cached for a week. Each entry: search query + filename rules.
//   any: list of token-groups; a file matches if ALL tokens of ANY group are in its title.
// Files from other parks (WDW, Tokyo, Paris, Shanghai, Hong Kong) are rejected.
// Wikipedia's lead image is the fallback for attractions.
// ---------------------------------------------------------------------------
const OTHER_PARKS = ['magic kingdom', 'walt disney world', 'wdw', 'tokyo', 'paris', 'shanghai', 'hong kong', 'hollywood studios', 'epcot', 'animal kingdom', 'disneysea', 'orlando', 'florida', 'logo', '.svg', 'map'];
export const PHOTO_QUERIES = {
  rides: {
    rise: ['Rise of the Resistance Disneyland', [['resistance']]],
    falcon: ['Millennium Falcon Galaxy\'s Edge Disneyland', [['falcon']]],
    indy: ['Indiana Jones Adventure Disneyland', [['indiana']]],
    space: ['Space Mountain Disneyland Anaheim', [['space', 'mountain']]],
    haunted: ['Haunted Mansion Disneyland New Orleans Square', [['haunted', 'mansion']]],
    thunder: ['Big Thunder Mountain Railroad Disneyland', [['thunder']]],
    mmrr: ['Runaway Railway Disneyland Toontown', [['runaway']]],
    pirates: ['Pirates of the Caribbean Disneyland', [['pirates', 'caribbean']]],
    matterhorn: ['Matterhorn Bobsleds Disneyland', [['matterhorn']]],
    jungle: ['Jungle Cruise Disneyland', [['jungle', 'cruise']]],
    tiana: ['Tiana\'s Bayou Adventure Disneyland', [['tiana']]],
    startours: ['Star Tours Disneyland Tomorrowland', [['star', 'tours']]],
    smallworld: ['it\'s a small world Disneyland', [['small', 'world']]],
    peterpan: ['Peter Pan\'s Flight Disneyland', [['peter', 'pan']]],
    toad: ['Mr. Toad\'s Wild Ride Disneyland', [['toad']]],
    alice: ['Alice in Wonderland Disneyland attraction', [['alice']]],
    buzz: ['Buzz Lightyear Astro Blasters Disneyland', [['buzz']]],
    autopia: ['Autopia Disneyland', [['autopia']]],
    nemo: ['Finding Nemo Submarine Voyage Disneyland', [['nemo'], ['submarine']]],
    tiki: ['Enchanted Tiki Room Disneyland', [['tiki']]],
    marktwain: ['Mark Twain Riverboat Disneyland', [['twain']]],
    railroad: ['Disneyland Railroad train', [['railroad'], ['station']]],
  },
  food: {
    food_plazainn: ['Plaza Inn Disneyland', [['plaza', 'inn']]],
    food_ronto: ['Ronto Roasters Galaxy\'s Edge', [['ronto']]],
    food_dockingbay: ['Docking Bay 7 Galaxy\'s Edge', [['docking', 'bay']]],
    food_tianas: ['Tiana\'s Palace Disneyland', [['tiana', 'palace']]],
    food_jolly: ['Jolly Holiday Bakery Disneyland', [['jolly', 'holiday']]],
    food_bengal: ['Bengal Barbecue Disneyland', [['bengal']]],
    food_tropical: ['Dole Whip Disneyland', [['dole', 'whip'], ['tropical', 'hideaway']]],
    food_mintjulep: ['Mint Julep Bar beignets Disneyland', [['mint', 'julep'], ['beignet', 'disney']]],
    food_gibson: ['Gibson Girl Ice Cream Parlor Disneyland', [['gibson', 'girl']]],
    food_hungrybear: ['Hungry Bear Restaurant Disneyland', [['hungry', 'bear']]],
    food_galactic: ['Galactic Grill Tomorrowland Disneyland', [['galactic', 'grill'], ['tomorrowland', 'terrace']]],
    food_carnation: ['Carnation Cafe Disneyland Main Street', [['carnation']]],
    food_harbour: ['Harbour Galley Disneyland', [['harbour', 'galley']]],
    food_goldenhorseshoe: ['Golden Horseshoe Disneyland Frontierland', [['golden', 'horseshoe']]],
    food_redwagon: ['Little Red Wagon corn dog Disneyland', [['red', 'wagon'], ['corn', 'dog', 'disney']]],
    popcorn: ['Disneyland popcorn bucket', [['popcorn']]],
  },
  shows: {
    fantasmic: ['Fantasmic Disneyland', [['fantasmic']]],
    fireworks: ['Disneyland fireworks Sleeping Beauty Castle', [['firework']]],
    cavalcade: ['Disneyland Halloween Main Street pumpkin', [['halloween'], ['pumpkin']]],
    castle: ['Sleeping Beauty Castle Disneyland Halloween', [['sleeping', 'beauty', 'castle'], ['castle', 'disneyland']]],
    galaxy: ['Black Spire Outpost Galaxy\'s Edge Disneyland', [['galaxy'], ['black', 'spire']]],
  },
};
// Manually verified photos win over the automatic search. Format:
//   rise: { src: 'https://upload.wikimedia.org/...', page: 'https://commons.wikimedia.org/wiki/File:...', author: '...', license: 'CC BY-SA 4.0' },
// After editing, bump PHOTO_CACHE_VERSION so the edge cache is refreshed.
export const PHOTO_OVERRIDES = {};
export const PHOTO_CACHE_VERSION = 3;

const stripTags = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
export function pickCommons(pages, groups) {
  let best = null;
  for (const p of pages || []) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/image\/(jpeg|png|webp)/.test(ii.mime || '')) continue;
    const t = String(p.title || '').toLowerCase().replace(/[_\-]/g, ' ');
    if (OTHER_PARKS.some((x) => t.includes(x))) continue;
    if (!groups.some((g) => g.every((tok) => t.includes(tok)))) continue;
    if ((ii.width || 0) < 500) continue;
    let score = 0;
    if (t.includes('disneyland')) score += 3;
    if (t.includes('anaheim') || t.includes('california')) score += 1;
    if ((ii.width || 0) >= ii.height) score += 1; // landscape fits the cards better
    score -= (p.index || 0) * 0.1;                // keep search relevance order as tiebreak
    if (!best || score > best.score) best = { score, p, ii };
  }
  if (!best) return null;
  const md = best.ii.extmetadata || {};
  return {
    src: best.ii.thumburl || best.ii.url,
    page: best.ii.descriptionurl,
    title: best.p.title.replace(/^File:/, ''),
    author: stripTags(md.Artist?.value),
    license: stripTags(md.LicenseShortName?.value),
    source: 'Wikimedia Commons',
  };
}
async function commonsSearch(q, groups) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=15'
    + '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=800&gsrsearch=' + encodeURIComponent(q);
  const j = await fetchJSON(u, 8000);
  return pickCommons(j?.query?.pages || [], groups);
}
export async function handlePhotos(ctx) {
  const url = new URL(ctx.request.url);
  const set = PHOTO_QUERIES[url.searchParams.get('set')] ? url.searchParams.get('set') : 'rides';
  const origin = url.origin;
  const key = `photos-v${PHOTO_CACHE_VERSION}-${set}`;
  const cached = await cacheGet(origin, key);
  if (cached) return json({ ...cached, cache: 'HIT' }, 200, 3600);
  const photos = {}, errors = [];
  // Commons only. Wikipedia's automatic lead images can be logos or photos from other parks.
  // Limit simultaneous Commons searches to reduce HTTP 429 rate limiting.
  const jobs = Object.entries(PHOTO_QUERIES[set]);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const [id, [q, groups]] = jobs[cursor++];
      if (PHOTO_OVERRIDES[id]) {
        photos[id] = { source: 'Wikimedia Commons', title: id, ...PHOTO_OVERRIDES[id] };
        continue;
      }
      try {
        const result = await commonsSearch(q, groups);
        if (result) photos[id] = result;
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }));
  const data = { ok: Object.keys(photos).length > 0, set, photos, fetchedAt: new Date().toISOString(), errors };
  if (data.ok) await cachePut(origin, key, data, errors.length > 5 ? 3600 : 7 * 86400, ctx.waitUntil?.bind(ctx));
  return json(data, data.ok ? 200 : 502, data.ok ? 3600 : 0);
}

// Shared server logic for the Cloudflare Pages Functions in /functions/api.
// Upstreams:
//   ThemeParks.wiki  https://api.themeparks.wiki/v1  (primary: waits, status, showtimes, coords, hours)
//   Queue-Times.com  https://queue-times.com/parks/16/queue_times.json (fallback: waits only)
//   Wikipedia REST   https://en.wikipedia.org/api/rest_v1/page/summary/{title} (photos)
// Every upstream response is cached at the edge so that phones polling us never
// multiply into upstream traffic (≈1 upstream call / minute at most for waits).
import * as DL from '../public/js/parks/dl.js';
import * as DCA from '../public/js/parks/dca.js';

export const PARKS = { dl: DL, dca: DCA };
// ?park=dca → California Adventure; anything else → Disneyland Park (backwards compatible).
export const parkFrom = (url) => PARKS[new URL(url).searchParams.get('park')] || DL;
const TRIP = DL.TRIP;
const { RESTAURANTS } = DL;

export const UA = 'dl-navi-1031 (personal trip planner; contact via GitHub saoki0913)';
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

export function normalizeTPWLive(json, P = DL) {
  const { ATTRACTIONS, SHOWS } = P;
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

export function normalizeQT(json, P = DL) {
  const { ATTRACTIONS } = P;
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

export function normalizeChildren(json, P = DL) {
  const { ATTRACTIONS, RESTAURANTS, SHOWS } = P;
  const box = P.PARK.box;
  const coords = {};
  for (const c of json?.children || []) {
    const lat = Number(c.location?.latitude), lon = Number(c.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // sanity box around the park
    if (lat < box.lat[0] || lat > box.lat[1] || lon < box.lon[0] || lon > box.lon[1]) continue;
    let id = null;
    if (c.entityType === 'ATTRACTION') id = matchId(c.name, ATTRACTIONS);
    else if (c.entityType === 'RESTAURANT') id = matchId(c.name, RESTAURANTS);
    else if (c.entityType === 'SHOW') id = matchId(c.name, SHOWS);
    if (id && !coords[id]) coords[id] = { lat, lon, name: c.name };
  }
  return coords;
}

export function normalizeSchedule(json, date = TRIP.date) {
  // `days` holds every date so the client can follow a user-changed trip date.
  const out = { date, operating: null, extra: [], days: {} };
  for (const s of json?.schedule || []) {
    if (!s.date) continue;
    const e = { type: s.type, open: localMinutes(s.openingTime), close: localMinutes(s.closingTime), description: s.description || null };
    const d = (out.days[s.date] ||= { operating: null, extra: [] });
    if (s.type === 'OPERATING' && !d.operating) d.operating = e;
    else d.extra.push(e);
  }
  if (out.days[date]) { out.operating = out.days[date].operating; out.extra = out.days[date].extra; }
  return out;
}

// The ThemeParks.wiki id is configured per park; if it ever stops resolving, look the park
// up by name in the destinations list (cached at the edge for a day).
async function tpwParkId(origin, P, waitUntil) {
  const key = `tpw-id-${P.PARK.id}`;
  const hit = await cacheGet(origin, key);
  if (hit?.id) return hit.id;
  return P.PARK.tpwId;
}
async function tpwFetch(origin, P, path, timeoutMs, waitUntil) {
  const id = await tpwParkId(origin, P, waitUntil);
  try {
    return await fetchJSON(`https://api.themeparks.wiki/v1/entity/${id}/${path}`, timeoutMs);
  } catch (e) {
    if (!/HTTP 4\d\d/.test(e.message)) throw e;
    const d = await fetchJSON('https://api.themeparks.wiki/v1/destinations', timeoutMs);
    const want = norm(P.PARK.tpwName);
    const park = (d?.destinations || []).flatMap((x) => x.parks || []).find((p) => norm(p.name).includes(want));
    if (!park?.id || park.id === id) throw e;
    await cachePut(origin, `tpw-id-${P.PARK.id}`, { id: park.id }, 86400, waitUntil);
    return await fetchJSON(`https://api.themeparks.wiki/v1/entity/${park.id}/${path}`, timeoutMs);
  }
}

// ---------- fetch + edge cache helpers ----------
export async function fetchJSON(url, timeoutMs = 8000) {
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
export async function cacheGet(origin, name) {
  try {
    const hit = await caches.default.match(cacheKey(origin, name));
    return hit ? await hit.json() : null;
  } catch { return null; }
}
export async function cachePut(origin, name, data, ttl, waitUntil) {
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
  const P = parkFrom(ctx.request.url);
  const pid = P.PARK.id;
  const wu = ctx.waitUntil?.bind(ctx);
  const cached = await cacheGet(origin, `live-v2-${pid}`);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < LIVE_TTL * 1000) {
    return json({ ...cached, cache: 'HIT' });
  }
  const errors = [];
  let result = null;
  try {
    const j = await tpwFetch(origin, P, 'live', 8000, wu);
    const n = normalizeTPWLive(j, P);
    if (n.matched >= 5) result = { ...n, source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki' };
    else errors.push(`themeparks.wiki: 一致した施設が少ない (${n.matched})`);
  } catch (e) { errors.push('themeparks.wiki: ' + e.message); }

  if (!result) {
    try {
      const j = await fetchJSON(`https://queue-times.com/parks/${P.PARK.qtId}/queue_times.json`);
      const n = normalizeQT(j, P);
      if (n.matched >= 5) result = { ...n, source: 'queue-times.com', sourceLabel: 'Queue-Times.com' };
      else errors.push(`queue-times.com: 一致した施設が少ない (${n.matched})`);
    } catch (e) { errors.push('queue-times.com: ' + e.message); }
  }

  if (result) {
    const data = { ok: true, park: pid, ...result, fetchedAt: new Date().toISOString(), errors };
    await cachePut(origin, `live-v2-${pid}`, data, LIVE_TTL, wu);
    await cachePut(origin, `live-last-good-${pid}`, data, LAST_GOOD_TTL, wu);
    return json({ ...data, cache: 'MISS' });
  }
  const last = await cacheGet(origin, `live-last-good-${pid}`);
  if (last) return json({ ...last, ok: true, stale: true, errors, cache: 'STALE' });
  return json({ ok: false, park: pid, errors, fetchedAt: new Date().toISOString() }, 502);
}

export async function handleMeta(ctx) {
  const origin = new URL(ctx.request.url).origin;
  const P = parkFrom(ctx.request.url);
  const pid = P.PARK.id;
  const wu = ctx.waitUntil?.bind(ctx);
  const cached = await cacheGet(origin, `meta-v2-${pid}`);
  if (cached) return json({ ...cached, cache: 'HIT' }, 200, 600);
  const errors = [];
  let coords = {}, schedule = null;
  const [c, s] = await Promise.allSettled([
    tpwFetch(origin, P, 'children', 10000, wu),
    tpwFetch(origin, P, 'schedule', 10000, wu),
  ]);
  if (c.status === 'fulfilled') coords = normalizeChildren(c.value, P); else errors.push('children: ' + c.reason.message);
  if (s.status === 'fulfilled') schedule = normalizeSchedule(s.value, P.TRIP.date); else errors.push('schedule: ' + s.reason.message);
  const data = { ok: !errors.length || Object.keys(coords).length > 0 || !!schedule, park: pid, coords, schedule, fetchedAt: new Date().toISOString(), source: 'themeparks.wiki', errors };
  if (data.ok) await cachePut(origin, `meta-v2-${pid}`, data, errors.length ? 900 : 6 * 3600, wu);
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
  // shops added later: a separate set keeps each request under the free-plan subrequest limit
  food2: {
    food_bluebayou: ['Blue Bayou Restaurant Disneyland', [['blue', 'bayou']]],
    food_cafeorleans: ['Cafe Orleans Disneyland', [['cafe', 'orleans']]],
    food_royalstreet: ['Royal Street Veranda Disneyland', [['royal', 'street']]],
    food_rancho: ['Rancho del Zocalo Disneyland', [['rancho'], ['zocalo']]],
    food_stagedoor: ['Stage Door Cafe Disneyland', [['stage', 'door']]],
    food_redrose: ['Red Rose Taverne Disneyland', [['red', 'rose']]],
    food_troubadour: ['Troubadour Tavern Disneyland', [['troubadour']]],
    food_edelweiss: ['Edelweiss Snacks Disneyland', [['edelweiss']]],
    food_alienpizza: ['Alien Pizza Planet Disneyland', [['pizza', 'planet'], ['pizza', 'port']]],
    food_cafedaisy: ['Cafe Daisy Toontown Disneyland', [['cafe', 'daisy']]],
    food_refreshment: ['Refreshment Corner Disneyland', [['refreshment', 'corner']]],
    food_markethouse: ['Market House Disneyland Main Street', [['market', 'house']]],
    food_poohcorner: ['Pooh Corner Disneyland', [['pooh', 'corner']]],
    food_milkstand: ['Milk Stand Galaxy\'s Edge', [['milk', 'stand'], ['blue', 'milk']]],
    food_katsaka: ['Kat Saka\'s Kettle Galaxy\'s Edge', [['kat', 'saka']]],
  },
  shows: {
    fantasmic: ['Fantasmic Disneyland', [['fantasmic']]],
    fireworks: ['Disneyland fireworks Sleeping Beauty Castle', [['firework']]],
    cavalcade: ['Disneyland Halloween Main Street pumpkin', [['halloween'], ['pumpkin']]],
    castle: ['Sleeping Beauty Castle Disneyland Halloween', [['sleeping', 'beauty', 'castle'], ['castle', 'disneyland']]],
    galaxy: ['Black Spire Outpost Galaxy\'s Edge Disneyland', [['galaxy'], ['black', 'spire']]],
  },
};
// Dish photos: one Commons search per menu item that has a `ph` key → id `menu_<shop>_<index>`.
PHOTO_QUERIES.menu = Object.fromEntries(RESTAURANTS.flatMap((r) => r.menu.map((m, i) => (m.ph ? [`menu_${r.id}_${i}`, m.ph] : null)).filter(Boolean)));
export const PHOTO_QUERIES_DCA = {
  rides: {
    rsr: ['Radiator Springs Racers Cars Land', [['radiator', 'springs']]],
    guardians: ['Guardians of the Galaxy Mission Breakout California Adventure', [['guardians'], ['breakout']]],
    webslingers: ['Web Slingers Spider-Man Avengers Campus', [['web', 'slingers'], ['avengers', 'campus']]],
    incredicoaster: ['Incredicoaster Pixar Pier', [['incredicoaster'], ['california', 'screamin']]],
    soarin: ["Soarin' California Adventure", [['soarin']]],
    tsmm: ['Toy Story Midway Mania California Adventure', [['midway', 'mania']]],
    grizzly: ['Grizzly River Run California Adventure', [['grizzly', 'river']]],
    monsters: ['Monsters Inc Mike Sulley to the Rescue', [['monsters']]],
    luigi: ["Luigi's Rollickin' Roadsters Cars Land", [['luigi']]],
    mater: ["Mater's Junkyard Jamboree Cars Land", [['mater']]],
    mermaid: ["Little Mermaid Ariel's Undersea Adventure California", [['mermaid'], ['ariel']]],
    goofy: ["Goofy's Sky School California Adventure", [['goofy']]],
    swings: ['Silly Symphony Swings California Adventure', [['silly', 'symphony']]],
    palaround: ['Pixar Pal-A-Round Ferris wheel', [['pal', 'round'], ['mickey', 'fun', 'wheel']]],
    insideout: ['Inside Out Emotional Whirlwind Pixar Pier', [['inside', 'out']]],
    turtle: ['Turtle Talk with Crush Disney California Adventure', [['turtle', 'talk']]],
    zephyr: ['Golden Zephyr California Adventure', [['zephyr']]],
    jessie: ["Jessie's Critter Carousel Pixar Pier", [['carousel']]],
  },
  food: {
    food_lamplight: ['Lamplight Lounge Pixar Pier', [['lamplight']]],
    food_carthay: ['Carthay Circle Theatre California Adventure', [['carthay']]],
    food_flos: ["Flo's V8 Cafe Cars Land", [['flo', 'v8'], ['flos']]],
    food_smokejumpers: ['Smokejumpers Grill Grizzly Peak', [['smokejumpers']]],
    food_luckyfortune: ['Lucky Fortune Cookery California Adventure', [['lucky', 'fortune']]],
    food_pacificwharf: ['Pacific Wharf California Adventure', [['pacific', 'wharf']]],
    food_pym: ['Pym Test Kitchen Avengers Campus', [['pym']]],
    food_paradisegrill: ['Paradise Garden Grill California Adventure', [['paradise', 'garden']]],
    food_clarabelle: ["Clarabelle's Buena Vista Street", [['clarabelle'], ['buena', 'vista', 'street']]],
    food_ghirardelli: ['Ghirardelli Soda Fountain California Adventure', [['ghirardelli']]],
    food_cozycone: ['Cozy Cone Motel Cars Land', [['cozy', 'cone']]],
    food_jackjack: ['Jack-Jack Cookie Num Nums Pixar Pier', [['jack', 'jack'], ['pixar', 'pier']]],
    food_catal: ['Catal Restaurant Downtown Disney', [['catal']]],
    food_naples: ['Naples Ristorante Downtown Disney', [['naples', 'disney'], ['downtown', 'disney']]],
  },
  food2: {},
  menu: {},
  shows: {
    worldofcolor: ['World of Color Disney California Adventure', [['world', 'of', 'color']]],
  },
};
// Manually verified photos win over the automatic search. Format:
//   rise: { src: 'https://upload.wikimedia.org/...', page: 'https://commons.wikimedia.org/wiki/File:...', author: '...', license: 'CC BY-SA 4.0' },
// After editing, bump PHOTO_CACHE_VERSION so the edge cache is refreshed.
export const PHOTO_OVERRIDES = {
  // Verified: Fantasmic! at Disneyland Park, photographed July 2010; PD-self.
  fantasmic: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8f/Fantasmic_July_4.jpg/960px-Fantasmic_July_4.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:Fantasmic_July_4.jpg',
    author: 'Alfred A. Si',
    license: 'Public domain',
  },
};
export const PHOTO_CACHE_VERSION = 5;

const stripTags = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
export function pickCommons(pages, groups, prefer = ['disneyland']) {
  let best = null;
  for (const p of pages || []) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/image\/(jpeg|png|webp)/.test(ii.mime || '')) continue;
    const t = String(p.title || '').toLowerCase().replace(/[_\-]/g, ' ');
    if (OTHER_PARKS.some((x) => t.includes(x))) continue;
    if (!groups.some((g) => g.every((tok) => t.includes(tok)))) continue;
    if ((ii.width || 0) < 500) continue;
    let score = 0;
    if (prefer.some((x) => t.includes(x))) score += 3;
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
async function commonsSearch(q, groups, prefer) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=15'
    + '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=800&gsrsearch=' + encodeURIComponent(q);
  const j = await fetchJSON(u, 8000);
  return pickCommons(j?.query?.pages || [], groups, prefer);
}
export async function handlePhotos(ctx) {
  const url = new URL(ctx.request.url);
  const P = parkFrom(ctx.request.url);
  const isDca = P.PARK.id === 'dca';
  const Q = isDca ? PHOTO_QUERIES_DCA : PHOTO_QUERIES;
  const prefer = isDca ? ['california adventure', 'cars land', 'pixar pier', 'avengers campus', 'dca'] : ['disneyland'];
  const set = Q[url.searchParams.get('set')] ? url.searchParams.get('set') : 'rides';
  const origin = url.origin;
  // Disneyland keeps its existing cache key; California Adventure gets its own.
  const key = `photos-v${PHOTO_CACHE_VERSION}-${isDca ? 'dca-' : ''}${set}`;
  const cached = await cacheGet(origin, key);
  if (cached) return json({ ...cached, cache: 'HIT' }, 200, 3600);
  const photos = {}, errors = [];
  // Commons only. Wikipedia's automatic lead images can be logos or photos from other parks.
  // Limit simultaneous Commons searches to reduce HTTP 429 rate limiting.
  const jobs = Object.entries(Q[set]);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const [id, [q, groups]] = jobs[cursor++];
      if (!isDca && PHOTO_OVERRIDES[id]) {
        photos[id] = { source: 'Wikimedia Commons', title: id, ...PHOTO_OVERRIDES[id] };
        continue;
      }
      try {
        const result = await commonsSearch(q, groups, prefer);
        if (result) photos[id] = result;
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }));
  const found = Object.keys(photos).length;
  // This endpoint is healthy even if Wikimedia temporarily rate-limits all searches.
  // The caller renders its honest fallback tiles for missing photos.
  const data = { ok: true, complete: found === Object.keys(Q[set]).length, park: P.PARK.id, set, photos, fetchedAt: new Date().toISOString(), errors };
  if (found) await cachePut(origin, key, data, errors.length > 5 ? 3600 : 7 * 86400, ctx.waitUntil?.bind(ctx));
  return json(data, 200, found ? 3600 : 60);
}

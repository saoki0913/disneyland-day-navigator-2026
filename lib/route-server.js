// Walking route inside the park for in-app guidance (/api/route?from=lat,lon&to=lat,lon).
// Uses the public OSRM foot router run by FOSSGIS on OpenStreetMap data. Only the two points are
// sent. Results are cached at the edge for a day. If the router fails or returns something
// implausible, the client falls back to a straight-line guide.
import { json, fetchJSON, cacheGet, cachePut } from './server.js';

const BOX = { lat: [33.79, 33.83], lon: [-117.94, -117.9] }; // Disneyland Resort area only
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

export function parsePoint(s) {
  const m = /^(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (lat < BOX.lat[0] || lat > BOX.lat[1] || lon < BOX.lon[0] || lon > BOX.lon[1]) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}
function straightM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// OSRM response → { coords:[[lat,lon]], distance, steps:[{type, modifier, name, distance, at:[lat,lon]}] }
export function normalizeOSRM(j, from, to) {
  const r = j?.code === 'Ok' ? j.routes?.[0] : null;
  const coords = r?.geometry?.coordinates?.map(([lon, lat]) => [lat, lon]);
  if (!r || !coords?.length || !Number.isFinite(r.distance)) return null;
  const direct = straightM(from, to);
  // A walk inside the park is never more than a few km; a huge detour means the map data is off.
  if (r.distance > 4000 || (direct > 60 && r.distance > direct * 4)) return null;
  const steps = (r.legs?.[0]?.steps || []).map((s) => ({
    type: s.maneuver?.type || '', modifier: s.maneuver?.modifier || '', name: s.name || '',
    distance: Math.round(s.distance || 0), at: s.maneuver?.location ? [s.maneuver.location[1], s.maneuver.location[0]] : null,
  }));
  return { coords: [[from.lat, from.lon], ...coords, [to.lat, to.lon]], distance: Math.round(r.distance), steps };
}

export async function handleRoute(ctx) {
  const u = new URL(ctx.request.url);
  const from = parsePoint(u.searchParams.get('from')), to = parsePoint(u.searchParams.get('to'));
  if (!from || !to) return json({ ok: false, error: 'bad-point' }, 400);
  // ~10 m grid for the cache key so two people walking together share results.
  const k = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  const name = `route-v1-${k(from)}-${k(to)}`;
  const origin = u.origin;
  const hit = await cacheGet(origin, name);
  if (hit) return json({ ...hit, from, to, cache: 'HIT' });
  try {
    const j = await fetchJSON(`${ROUTER}${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`, 8000);
    const r = normalizeOSRM(j, from, to);
    if (!r) return json({ ok: false, error: 'no-route' }, 502);
    const data = { ok: true, source: 'OpenStreetMap (FOSSGIS OSRM)', ...r };
    await cachePut(origin, name, data, 86400, ctx.waitUntil?.bind(ctx));
    return json({ ...data, cache: 'MISS' });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

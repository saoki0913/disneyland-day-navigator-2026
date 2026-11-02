// Day records ("思い出の記録"): what was ridden / eaten / watched on one day at one park.
// DOM-free: used by the phone (archive, recovery, PDF) and by the server (/api/records merge).
//
// record = { v: 1, park: 'dl' | 'dca', date: 'YYYY-MM-DD', savedAt: ms,
//            items: [{ id, name, kind: 'ride' | 'meal' | 'show', min: parkMinutes | null, at: ms | null }],
//            partial: true when some times are unknown (recovered from traces) }
export const RECORD_PARKS = ['dl', 'dca'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'America/Los_Angeles';

export const kindOf = (id) => (String(id).startsWith('meal:') ? 'meal' : String(id).startsWith('show:') ? 'show' : 'ride');
export const laDate = (ms, tz = TZ) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ms));
const laMin = (ms, tz = TZ) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
};
const finite = (x, lo, hi) => (Number.isFinite(x) && x >= lo && x <= hi ? x : null);

export function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const park = String(r.park || '');
  const date = String(r.date || '');
  if (!RECORD_PARKS.includes(park) || !DATE_RE.test(date)) return null;
  const seen = new Set();
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, 200).map((it) => {
    const id = String(it?.id || '').slice(0, 60);
    if (!id || seen.has(id) || !/^[\w:@.-]+$/.test(id)) return null;
    seen.add(id);
    return {
      id, name: String(it.name || id).slice(0, 80), kind: ['ride', 'meal', 'show'].includes(it.kind) ? it.kind : kindOf(id),
      min: finite(it.min, 0, 1440 * 2), at: finite(it.at, 1e12, 1e13),
    };
  }).filter(Boolean);
  if (!items.length) return null;
  sortItems(items);
  return { v: 1, park, date, savedAt: finite(r.savedAt, 0, 1e13) || 0, items, partial: items.some((i) => i.min == null) };
}

function sortItems(items) {
  // Known times first in time order; unknown times after, in their original order.
  items.sort((a, b) => (a.min == null) - (b.min == null) || (a.min ?? 0) - (b.min ?? 0) || (a.at ?? 0) - (b.at ?? 0));
  return items;
}

// Union of two records for the same park and day: the version of each item with a known time wins.
export function mergeRecords(a, b) {
  a = cleanRecord(a); b = cleanRecord(b);
  if (!a || !b) return a || b;
  const by = new Map(a.items.map((i) => [i.id, i]));
  for (const i of b.items) {
    const cur = by.get(i.id);
    if (!cur) { by.set(i.id, i); continue; }
    by.set(i.id, {
      ...cur,
      name: cur.name === cur.id ? i.name : cur.name,
      min: cur.min ?? i.min,
      at: cur.at != null && i.at != null ? Math.min(cur.at, i.at) : cur.at ?? i.at,
    });
  }
  return cleanRecord({ park: a.park, date: a.date, savedAt: Math.max(a.savedAt, b.savedAt), items: [...by.values()] });
}

// A record of the current day from the app state ({ done: {id: ms}, doneMin: {id: min} }).
export function recordFrom({ park, date, done = {}, doneMin = {}, nameOf = (id) => id, now = Date.now() }) {
  return cleanRecord({
    park, date, savedAt: now,
    items: Object.keys(done).map((id) => ({ id, name: nameOf(id), kind: kindOf(id), min: Number.isFinite(doneMin[id]) ? doneMin[id] : (Number.isFinite(done[id]) ? laMin(done[id]) : null), at: done[id] })),
  });
}

// Recovery from a shared plan document (/api/share/:code) for one day:
//  * records still in `done` whose completion time falls on that day → full items with times;
//  * otherwise the tombstones a new-day reset left behind (`doneDel` stamped on the first later day)
//    → the ids only (times unknown). Manual "未完了に戻す" happen on the same day, so they are skipped.
export function recoverFromDoc(doc, { park, date, nameOf = (id) => id, tz = TZ }) {
  const done = doc?.done || {}, doneMin = doc?.doneMin || {}, del = doc?.doneDel || {};
  const full = Object.keys(done).filter((id) => Number.isFinite(done[id]) && laDate(done[id], tz) === date);
  if (full.length) {
    return recordFrom({ park, date, nameOf, now: Date.now(), done: Object.fromEntries(full.map((id) => [id, done[id]])), doneMin });
  }
  return recoverFromTombstones(del, { park, date, nameOf, tz });
}
export function recoverFromTombstones(doneDel, { park, date, nameOf = (id) => id, tz = TZ }) {
  const later = Object.entries(doneDel || {}).filter(([, t]) => Number.isFinite(t) && laDate(t, tz) > date);
  if (!later.length) return null;
  const firstDay = later.map(([, t]) => laDate(t, tz)).sort()[0];
  const ids = later.filter(([, t]) => laDate(t, tz) === firstDay).map(([id]) => id);
  const rec = cleanRecord({ park, date, savedAt: Date.now(), items: ids.map((id) => ({ id, name: nameOf(id), kind: kindOf(id), min: null, at: null })) });
  return rec;
}

// Old on-device archive format ({ done, doneMin }) → record.
export function recordFromLegacyLog(raw, { park, date, nameOf }) {
  if (raw?.items) return cleanRecord({ ...raw, park, date });
  const own = recordFrom({ park, date, done: raw?.done || {}, doneMin: raw?.doneMin || {}, nameOf, now: 0 });
  const base = raw?.base?.items ? cleanRecord({ ...raw.base, park, date }) : null;
  return own && base ? mergeRecords(base, own) : own || base;
}

export function recordStats(rec) {
  const by = { ride: 0, meal: 0, show: 0 };
  for (const i of rec.items) by[i.kind]++;
  const times = rec.items.map((i) => i.min).filter((m) => m != null);
  return { ...by, total: rec.items.length, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null };
}

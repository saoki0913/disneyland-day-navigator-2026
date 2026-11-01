// ---------------------------------------------------------------------------
// Park selector. Each park's catalog lives in ./parks/<id>.js with identical exports.
// The selected park is read once at startup (the UI reloads the page on switch),
// so every importer (engine.js, app.js) sees one consistent park.
//   * stored choice ('dlnavi-park' in localStorage) wins;
//   * otherwise the park whose trip date is today (or the next upcoming one) in Anaheim.
// The server never uses this module's selection — it imports ./parks/* directly.
// ---------------------------------------------------------------------------
import * as dl from './parks/dl.js';
import * as dca from './parks/dca.js';

export const PARKS = { dl, dca };
export const PARK_ORDER = ['dl', 'dca'];
export const PARK_STORE = 'dlnavi-park';

export function defaultParkFor(todayISO) {
  const upcoming = PARK_ORDER.find((id) => PARKS[id].TRIP.date >= todayISO);
  return upcoming || PARK_ORDER[0];
}
function initialPark() {
  try {
    const stored = globalThis.localStorage?.getItem(PARK_STORE);
    if (stored && PARKS[stored]) return stored;
  } catch { /* no storage (server / private mode) */ }
  try {
    if (typeof window === 'undefined') return 'dl';
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles' }).format(new Date());
    return defaultParkFor(today);
  } catch { return 'dl'; }
}
export const PARK_ID = initialPark();
const P = PARKS[PARK_ID];

export const {
  PARK, TRIP, PARK_ID_TPW, PARK_ID_QT, DEFAULT_MUST, LANDS, landById, ATTRACTIONS, attractionById,
  RESTAURANTS, restaurantById, POPCORN, SHOWS, showById, ENTERTAINMENT, PLANS, PRIORITY, WAIT_CURVE,
} = P;

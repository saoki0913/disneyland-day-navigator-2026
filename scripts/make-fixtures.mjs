// Builds TEST fixtures shaped like ThemeParks.wiki / Queue-Times responses.
// These are synthetic values for automated tests only — never served to users.
import { writeFileSync } from 'node:fs';
const t = (h, m) => `2026-10-31T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-07:00`;
const rides = [
  ['Star Wars: Rise of the Resistance', 'DOWN', null], ['Millennium Falcon: Smugglers Run', 'OPERATING', 45],
  ['Indiana Jones™ Adventure', 'OPERATING', 25], ['Space Mountain', 'OPERATING', 55], ['Haunted Mansion Holiday', 'OPERATING', 60],
  ['Big Thunder Mountain Railroad', 'OPERATING', 35], ["Mickey & Minnie's Runaway Railway", 'OPERATING', 40],
  ['Pirates of the Caribbean', 'OPERATING', 20], ['Matterhorn Bobsleds', 'OPERATING', 50], ['Jungle Cruise', 'OPERATING', 30],
  ["Tiana's Bayou Adventure", 'OPERATING', 45], ['Star Tours - The Adventures Continue', 'OPERATING', 15],
  ['"it\'s a small world"', 'REFURBISHMENT', null], ["Peter Pan's Flight", 'OPERATING', 50], ["Mr. Toad's Wild Ride", 'OPERATING', 20],
  ['Alice in Wonderland', 'OPERATING', 25], ['Buzz Lightyear Astro Blasters', 'OPERATING', 25], ['Autopia', 'OPERATING', 30],
  ['Finding Nemo Submarine Voyage', 'OPERATING', 25], ["Walt Disney's Enchanted Tiki Room", 'OPERATING', 5],
  ['Mark Twain Riverboat', 'OPERATING', 10], ['Disneyland Railroad - Main Street Station', 'OPERATING', 5],
  ['Pirate\'s Lair on Tom Sawyer Island', 'OPERATING', 5],
];
const liveData = rides.map(([name, status, w], i) => ({
  id: `fixture-${i}`, name, entityType: 'ATTRACTION', parkId: '7340550b-c14d-4def-80bb-acdb51d49a66', status,
  queue: { STANDBY: { waitTime: w }, ...(name.includes('Smugglers') ? { SINGLE_RIDER: { waitTime: 15 } } : {}) },
  lastUpdated: '2026-10-31T17:02:00Z',
}));
liveData.push(
  { id: 'fx-s1', name: 'Fantasmic!', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: t(21, 0), endTime: t(21, 22) }, { type: 'Performance Time', startTime: t(22, 30), endTime: t(22, 52) }], lastUpdated: '2026-10-31T17:00:00Z' },
  { id: 'fx-s2', name: 'Halloween Screams', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: t(21, 30), endTime: t(21, 45) }] },
  { id: 'fx-s3', name: 'Mickey and Friends Halloween Cavalcade', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: t(13, 30), endTime: t(13, 45) }, { type: 'Performance Time', startTime: t(14, 45), endTime: t(15, 0) }] },
  { id: 'fx-s4', name: 'Main Street Philharmonic', entityType: 'SHOW', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: t(11, 0), endTime: t(11, 20) }] },
);
writeFileSync('tests/fixtures/tpw-live.json', JSON.stringify({ id: '7340550b-c14d-4def-80bb-acdb51d49a66', name: 'Disneyland Park', entityType: 'PARK', timezone: 'America/Los_Angeles', liveData }, null, 1));
writeFileSync('tests/fixtures/qt.json', JSON.stringify({ lands: [{ id: 1, name: 'Tomorrowland', rides: [{ id: 1, name: 'Space Mountain', is_open: true, wait_time: 40, last_updated: '2026-10-31T17:00:00.000Z' }, { id: 2, name: 'Star Tours - The Adventures Continue', is_open: true, wait_time: 10, last_updated: '2026-10-31T17:00:00.000Z' }] }, { id: 2, name: "Star Wars: Galaxy's Edge", rides: [{ id: 3, name: 'Star Wars: Rise of the Resistance', is_open: false, wait_time: 0, last_updated: '2026-10-31T17:00:00.000Z' }, { id: 4, name: 'Millennium Falcon: Smugglers Run', is_open: true, wait_time: 35, last_updated: '2026-10-31T17:00:00.000Z' }] }, { id: 3, name: 'Adventureland', rides: [{ id: 5, name: 'Indiana Jones™ Adventure', is_open: true, wait_time: 30, last_updated: '2026-10-31T17:00:00.000Z' }, { id: 6, name: 'Jungle Cruise', is_open: true, wait_time: 20, last_updated: '2026-10-31T17:00:00.000Z' }] }], rides: [] }, null, 1));
writeFileSync('tests/fixtures/tpw-children.json', JSON.stringify({ children: [
  { id: 'c1', name: 'Star Wars: Rise of the Resistance', entityType: 'ATTRACTION', location: { latitude: 33.81548, longitude: -117.92357 } },
  { id: 'c2', name: 'Plaza Inn', entityType: 'RESTAURANT', location: { latitude: 33.81188, longitude: -117.91843 } },
  { id: 'c3', name: 'Far Away Thing', entityType: 'ATTRACTION', location: { latitude: 28.4, longitude: -81.5 } },
] }, null, 1));
writeFileSync('tests/fixtures/tpw-schedule.json', JSON.stringify({ schedule: [
  { date: '2026-10-30', type: 'OPERATING', openingTime: '2026-10-30T08:00:00-07:00', closingTime: '2026-10-30T23:00:00-07:00' },
  { date: '2026-10-31', type: 'EXTRA_HOURS', description: 'Early Entry', openingTime: '2026-10-31T07:30:00-07:00', closingTime: '2026-10-31T08:00:00-07:00' },
  { date: '2026-10-31', type: 'OPERATING', openingTime: '2026-10-31T08:00:00-07:00', closingTime: '2026-10-31T23:00:00-07:00' },
] }, null, 1));
console.log('fixtures written');

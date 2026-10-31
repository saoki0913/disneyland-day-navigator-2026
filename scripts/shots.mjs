// Usage: node scripts/shots.mjs [baseUrl] [simHHMM]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizeTPWLive, normalizeChildren, normalizeSchedule } from '../lib/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8788';
const [hh, mm] = (process.argv[3] || '10:00').split(':').map(Number);
const live = { ok: true, ...normalizeTPWLive(JSON.parse(readFileSync('tests/fixtures/tpw-live.json'))), source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki', fetchedAt: new Date().toISOString(), errors: [] };
const meta = { ok: true, coords: normalizeChildren(JSON.parse(readFileSync('tests/fixtures/tpw-children.json'))), schedule: normalizeSchedule(JSON.parse(readFileSync('tests/fixtures/tpw-schedule.json'))), fetchedAt: new Date().toISOString(), errors: [] };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'America/Los_Angeles' });
await ctx.route('**/api/live', (r) => r.fulfill({ json: live }));
await ctx.route('**/api/meta', (r) => r.fulfill({ json: meta }));
await ctx.route('**/api/photos', (r) => r.fulfill({ status: 502, json: { ok: false } }));
await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.addInitScript(([h, m]) => { if (!localStorage.getItem('dlnavi-1031-v1')) localStorage.setItem('dlnavi-1031-v1', JSON.stringify({ sim: { base: h * 60 + m, setAt: Date.now() } })); }, [hh, mm]);
await p.goto(base + '/');
await p.waitForTimeout(800);
for (const tab of ['home', 'plan', 'map', 'explore', 'shows']) {
  await p.click(`.tab[data-tab="${tab}"]`);
  await p.waitForTimeout(tab === 'map' ? 1500 : 400);
  await p.screenshot({ path: `screenshots/tmp/${tab}.png`, fullPage: tab !== 'map' });
}
await p.click('.tab[data-tab="home"]');
await b.close();
console.log('ok');

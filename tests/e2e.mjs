// End-to-end browser test (Playwright, iPhone-sized). Usage: node tests/e2e.mjs [baseUrl]
// API responses are mocked from test fixtures so the run is deterministic.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { normalizeTPWLive, normalizeChildren, normalizeSchedule } from '../lib/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8788';
const SHOTS = process.env.SHOTS || 'screenshots';
mkdirSync(SHOTS, { recursive: true });
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
let liveVariant = 0;
let pauseId = null;
// The app plans for today (Anaheim); move the fixture's dated show times to today.
const TODAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles' }).format(new Date());
const toToday = (n) => { for (const sh of [...Object.values(n.shows || {}), ...(n.otherShows || [])]) for (const t of sh.times || []) if (t.date) t.date = TODAY; return n; };
const live = () => { const n = toToday(normalizeTPWLive(fx('tpw-live.json'))); if (pauseId && n.attractions[pauseId]) n.attractions[pauseId] = { ...n.attractions[pauseId], status: 'DOWN', wait: null }; if (liveVariant === 1) { n.attractions.rise = { ...n.attractions.rise, status: 'OPERATING', wait: 40 }; n.attractions.space = { ...n.attractions.space, wait: 25 }; } return ({ ok: true, ...n, source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki', fetchedAt: new Date().toISOString(), errors: [] }); };
const meta = { ok: true, coords: normalizeChildren(fx('tpw-children.json')), schedule: normalizeSchedule(fx('tpw-schedule.json')), errors: [] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEYQHqXc2zYwAAAABJRU5ErkJggg==', 'base64');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n   ', e.message.slice(0, 1500)); }
}
const browser = await chromium.launch();
async function newCtx({ liveMode = 'ok', sim = '10:00', geo = null, photos = 'ok' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'America/Los_Angeles',
    ...(geo ? { geolocation: geo, permissions: ['geolocation'] } : {}),
  });
  await ctx.route('**/api/live*', (r) => liveMode === 'ok' ? r.fulfill({ json: live() }) : r.fulfill({ status: 502, json: { ok: false, errors: ['themeparks.wiki: HTTP 503', 'queue-times.com: timeout'] } }));
  await ctx.route('**/api/meta*', (r) => r.fulfill({ json: meta }));
  await ctx.route('**/api/photos*', (r) => photos === 'ok'
    ? r.fulfill({ json: { ok: true, photos: { rise: { src: 'https://upload.wikimedia.org/test/rise.png', page: 'https://commons.wikimedia.org/wiki/File:x', title: 'Rise', author: 'Test', license: 'CC BY 4.0', source: 'Wikimedia Commons' }, indy: { src: 'https://upload.wikimedia.org/test/broken.png', page: '', title: 'Indy', source: 'Wikimedia Commons' } } } })
    : r.fulfill({ status: 502, json: { ok: false } }));
  await ctx.route('https://upload.wikimedia.org/test/rise.png', (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await ctx.route('https://upload.wikimedia.org/test/broken.png', (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  await ctx.route('**/api/restrooms*', (r) => r.fulfill({ status: 502, json: { ok: false } })); // → approximate fallback list
  const [h, m] = sim.split(':').map(Number);
  await ctx.addInitScript((v) => { if (!localStorage.getItem('dlnavi-park')) localStorage.setItem('dlnavi-park', 'dl'); if (!localStorage.getItem('dlnavi-1031-v1')) localStorage.setItem('dlnavi-1031-v1', JSON.stringify({ sim: { base: v, setAt: Date.now() } })); }, h * 60 + m);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.waitForSelector('.next__title');
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const tab = async (p, t) => { await p.click(`.tab[data-tab="${t}"]`); await p.waitForTimeout(250); };
// Full rebuilds open a 作り直し案 sheet first; 反映 applies it (no sheet when nothing changes).
const accept = async (p) => { await p.waitForTimeout(150); if (await p.locator('#sheet [data-act="proposal-apply"]').count()) { await p.click('#sheet [data-act="proposal-apply"]'); await p.waitForTimeout(250); } };
// After your own reorder / "次に行く", a 動線を整える案 sheet may open — このまま keeps your order.
const dismissReflow = async (p) => { await p.waitForTimeout(450); if (await p.locator('#sheet:not([hidden]) [data-act="suggest-off"]').count()) { await p.click('#sheet [data-act="suggest-off"]'); await p.waitForTimeout(150); } };
const noHScroll = async (p) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');

// ---------- A: normal day with live data ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('1. iPhone size: home renders the Next Stop card, no horizontal scroll', async () => {
    const t = await page.textContent('.next__title');
    assert.ok(t.trim().length > 0);
    assert.ok(await page.evaluate(() => document.querySelector('.topbar').offsetHeight <= 140), 'compact artwork header');
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundImage), /land-(day|sunset|night)\.webp/, 'park skyline artwork');
    await noHScroll(page);
    await page.screenshot({ path: `${SHOTS}/01-home.png` });
    await page.screenshot({ path: `${SHOTS}/01-home-full.png`, fullPage: true });
  });
  await step('2. All four tabs switch views', async () => {
    for (const t of ['plan', 'map', 'explore', 'home']) {
      await tab(page, t);
      assert.equal(await page.getAttribute(`#view-${t}`, 'hidden'), null, t);
      assert.equal(await page.getAttribute(`.tab[data-tab="${t}"]`, 'aria-current'), 'page');
      if (t !== 'map') await noHScroll(page);
    }
  });
  await step('5. LIVE values are shown with LIVE label + source', async () => {
    assert.match(await page.textContent('#livePillText'), /LIVE/);
    assert.ok(await page.locator('.next .tag--live').count() >= 1);
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#sheet'), /ThemeParks\.wiki/);
    await page.click('.sheet__close'); await page.waitForTimeout(100);
  });
  await step('12. DOWN must-ride is flagged once as a snackbar (not a lingering card) and not recommended now', async () => {
    const seen = await page.evaluate(() => [...window.__dlnavi.R.noteSeen].join(','));
    assert.match(seen, /rise:/);
    assert.equal(await page.locator('#view-home .note').count(), 0, 'no lingering notice cards on home');
    assert.doesNotMatch(await page.textContent('.next__title'), /レジスタンス/);
  });
  await step('Home: next action first, then a slim progress band that expands on tap', async () => {
    const order = await page.$$eval('#view-home > *', (els) => els.map((e) => e.className));
    assert.match(order[0], /qa/, 'quick actions under the header');
    assert.match(order[1], /next/, 'next action first');
    assert.match(order[2], /pband/, 'progress right below');
    assert.ok((await page.locator('.pband').boundingBox()).height <= 56, 'slim band');
    assert.equal(await page.locator('.pband__body').count(), 0);
    await page.click('.pband__h'); await page.waitForTimeout(150);
    assert.ok(await page.locator('.pband__body .mini__i').count() >= 3, 'upcoming list');
    await page.screenshot({ path: `${SHOTS}/01b-home-progress-open.png`, fullPage: true });
    await page.click('.pband__h'); await page.waitForTimeout(100);
    assert.equal(await page.locator('#view-home .locrow').count(), 0, 'location row moved to settings');
  });
  await step('3/4. Plan builder: every pace keeps both Star Wars rides', async () => {
    await tab(page, 'plan');
    for (const id of ['relax', 'rides', 'balance']) {
      await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
      await page.click(`[data-b-set="plan"][data-v="${id}"]`); await page.waitForTimeout(150);
      assert.ok(await page.locator(`[data-b-set="plan"][data-v="${id}"].is-active`).count() === 1);
      await page.click('[data-act="plan-apply"]'); await accept(page); await page.waitForTimeout(200);
      const tl = await page.textContent('ol.tl:not(.tl--done)');
      // rise is DOWN in the fixture → stays in the plan marked 休止中 (takes no time)
      assert.match(await page.textContent('.tl__item--paused'), /レジスタンスの台頭/, `${id} rise shown as paused`);
      assert.match(tl, /ミレニアム・ファルコン/, `${id} falcon`);
      await page.screenshot({ path: `${SHOTS}/03-plan-${id}.png`, fullPage: true });
    }
    assert.match(await page.textContent('#toast'), /反映しました|最適です/);
  });
  await step('3b. Plan builder: conditions (must ride / skip ride / walking) change the plan; tabs fit one screen', async () => {
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-b-set="maxWait"]').count(), 0, 'no crowd / max-wait condition');
    for (const t of ['base', 'rides', 'meals', 'shows']) {
      await page.click(`[data-b-tab="${t}"]`); await page.waitForTimeout(120);
      const [sh, ch] = await page.evaluate(() => { const b = document.querySelector('.builder__body'); return [b.scrollHeight, b.clientHeight]; });
      assert.ok(sh <= ch + 2, `${t} tab fits without scrolling (${sh} > ${ch})`);
      assert.ok(await page.evaluate(() => document.querySelector('.sheet__panel').scrollHeight <= document.querySelector('.sheet__panel').clientHeight + 2), `${t}: sheet does not scroll`);
    }
    await page.click('[data-b-tab="base"]'); await page.waitForTimeout(100);
    await page.click('[data-b-set="walk"][data-v="low"]'); await page.waitForTimeout(100);
    await page.click('[data-b-tab="rides"]'); await page.waitForTimeout(100);
    await page.click('[data-b-ride="matterhorn"]'); await page.waitForTimeout(100); // → must
    assert.equal(await page.locator('[data-b-ride="matterhorn"].is-must').count(), 1);
    await page.click('[data-b-ride="pirates"]'); await page.click('[data-b-ride="pirates"]'); await page.waitForTimeout(100); // → skip
    assert.equal(await page.locator('[data-b-ride="pirates"].is-skip').count(), 1);
    await page.screenshot({ path: `${SHOTS}/03-plan-builder.png` });
    await page.click('[data-act="plan-apply"]'); await accept(page); await page.waitForTimeout(200);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    assert.match(tl, /マッターホーン/);
    assert.doesNotMatch(tl, /カリブの海賊/);
    assert.match(await page.textContent('.condsum'), /歩く量少なめ/);
    // restore
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.click('[data-b-set="walk"][data-v="normal"]');
    await page.click('[data-b-tab="rides"]'); await page.waitForTimeout(100);
    await page.click('[data-b-ride="matterhorn"]'); await page.click('[data-b-ride="matterhorn"]');
    await page.click('[data-b-ride="pirates"]');
    await page.click('[data-act="plan-apply"]'); await accept(page); await page.waitForTimeout(200);
  });
  await step('3c. Plan builder: visit counts only for rides you choose (×2 → ×3 → 1); fits one screen', async () => {
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.click('[data-b-tab="rides"]'); await page.click('[data-b-ridemode="count"]'); await page.waitForTimeout(100);
    await page.click('[data-b-rep="space"]'); await page.waitForTimeout(80);
    assert.match(await page.textContent('[data-b-rep="space"]'), /×2/);
    await page.click('[data-b-rep="space"]'); await page.click('[data-b-rep="space"]'); await page.waitForTimeout(80);
    assert.doesNotMatch(await page.textContent('[data-b-rep="space"]'), /×/, 'back to once');
    await page.click('[data-b-rep="space"]'); await page.waitForTimeout(80);
    const [sh, ch] = await page.evaluate(() => { const b = document.querySelector('.builder__body'); return [b.scrollHeight, b.clientHeight]; });
    assert.ok(sh <= ch + 2, `count mode fits (${sh} > ${ch})`);
    assert.equal(await page.evaluate(() => window.__dlnavi.R.draft.prefs.repeats.space), 2);
    await page.click('.sheet__close'); await page.waitForTimeout(150);
  });
  await step('Explore: every category tab is visible; home ほかの候補 are photo cards', async () => {
    await tab(page, 'explore');
    assert.ok(await page.evaluate(() => { const e = document.querySelector('.explore-tabs'); return e.scrollWidth <= e.clientWidth + 1; }), 'no clipped tab');
    await tab(page, 'home');
    assert.ok(await page.locator('.altcards .altc').count() >= 2, 'suggestion cards');
  });
  await step('11. Timeline: meals/shows appear once each, in time order, no overlap with rides', async () => {
    const items = await page.$$eval('ol.tl:not(.tl--done) .tl__item', (els) => els.map((e) => ({ t: e.querySelector('.tl__time').textContent, cls: e.className, name: e.querySelector('.tl__name')?.textContent || '' })));
    const toMin = (s) => { const [h, m] = s.replace(/[^\d:]/g, '').split(':').map(Number); return h * 60 + m; };
    const timed = items.filter((i) => /\d:\d/.test(i.t)); // paused rows show 休止 instead of a time
    for (let i = 1; i < timed.length; i++) assert.ok(toMin(timed[i].t) >= toMin(timed[i - 1].t), `order ${timed[i - 1].t} > ${timed[i].t}`);
    const fant = items.filter((i) => /ファンタズミック/.test(i.name));
    assert.equal(fant.length, 1, 'Fantasmic once');
  });
  await step('Plan: shows the REAL current wait (LIVE) and a clear re-plan panel', async () => {
    await tab(page, 'plan');
    const live = page.locator('.tl--plan .tl__wait.is-live');
    assert.ok(await live.count() >= 1, 'LIVE wait in the timeline');
    assert.match(await live.first().textContent(), /^\s*\d+分\s*$/, 'just the figure — waits are a reference');
    const top = await page.evaluate(() => document.querySelector('.tl--plan > li[data-ride]').getBoundingClientRect().top);
    // artwork header (~120px) + the テスト時刻 banner shown in these tests: still in the top half of a 667px screen
    assert.ok(top < 300, `plan timeline is visible right away (first ride at ${top}px)`);
    const replanY = await page.evaluate(() => document.querySelector('.replan').getBoundingClientRect().top);
    const tlBottom = await page.evaluate(() => document.querySelector('.tl--plan').getBoundingClientRect().bottom);
    assert.ok(replanY > tlBottom, 're-plan panel is below the timeline');
    // no sentences: a time stamp (= re-plan button) and where you are
    assert.match(await page.textContent('.tl__item--now .tl__upd'), /^\s*\d{1,2}:\d{2}\s*$/);
    assert.equal(await page.locator('.tl__item--now [data-act="pick-land"]').count(), 1, 'position chip');
    assert.ok((await page.textContent('.tl__item--now')).trim().length <= 30, 'no explanatory text in the plan header');
    assert.equal(await page.locator('.replan__hint, .replan__uses').count(), 0);
    assert.match(await page.textContent('.replan [data-act="replan"]'), /作り直す/);
    assert.equal(await page.locator('.tl--plan .tl__grip').count(), 0, 'no decorative icon or handle in normal plan');
    assert.equal(await page.locator('.tl--plan .tl__orderbtns').count(), 0, 'no arrow controls');
  });
  await step('Plan: drag & drop changes the ride order (and the home "next")', async () => {
    await tab(page, 'plan');
    await page.click('[data-act="plan-edit-order"]'); await page.waitForTimeout(100);
    const ids = await page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    assert.ok(ids.length >= 3);
    const target = ids.find((id, i) => i > 0 && id !== 'rise'); // rise is DOWN in the fixture (can't go first now)
    await page.evaluate((t) => { const r = document.querySelector(`.tl--plan > li[data-ride="${t}"]`).getBoundingClientRect(); scrollBy(0, r.top - 500); }, target);
    await page.waitForTimeout(100);
    const g = await page.locator(`[data-grip="${target}"]`).boundingBox();
    const first = await page.locator(`.tl--plan > li[data-ride="${ids[0]}"]`).boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + ((first.y + 6) - (g.y + g.height / 2)) * (i / 8));
    assert.equal(await page.locator('.tl__drop:not([hidden])').count(), 1, 'drop indicator');
    await page.screenshot({ path: `${SHOTS}/03-plan-drag.png` });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    assert.equal(after[0], target, `dragged ${target} first, got ${after.join(',')}`);
    assert.match(await page.textContent('#toast'), /順番|間に合わない/);
    await dismissReflow(page);
    assert.equal((await page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride)))[0], target, 'このまま keeps your order');
    await page.click('[data-act="plan-edit-done"]'); await page.waitForTimeout(100);

    await tab(page, 'home');
    assert.equal(await page.getAttribute('#actionbar [data-done]', 'data-done'), target, 'home follows the custom order');
    await tab(page, 'plan');
    await page.click('.replan [data-act="replan"]'); await accept(page); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__dlnavi.S.order), null, 'order reset');
    assert.match(await page.textContent('#toast'), /反映しました|最適です/);
    assert.equal(await page.locator('.tl__item--now.is-fresh').count(), 1, 'fresh stamp');
    await page.screenshot({ path: `${SHOTS}/03-plan-replan.png`, fullPage: true });
  });
  await step('Lock: a locked ride keeps its place when the plan is re-optimised (更新)', async () => {
    await tab(page, 'plan');
    const ids = await page.$$eval('.tl--plan > li[data-ride]:not(.tl__item--paused)', (els) => els.map((e) => e.dataset.ride));
    const target = ids[ids.length - 1];
    const seqIdx = () => page.evaluate((t) => { const s = window.__dlnavi.S; return s.planSnap.seq.filter((x) => !s.done[x]).indexOf(t); }, target);
    // move it to the top, lock it there, then 更新
    await page.click('[data-act="plan-edit-order"]'); await page.waitForTimeout(100);
    await page.evaluate((t) => { const r = document.querySelector(`.tl--plan > li[data-ride="${t}"]`).getBoundingClientRect(); scrollBy(0, r.top - 400); }, target);
    const g = await page.locator(`[data-grip="${target}"]`).boundingBox();
    const top = await page.locator('.tl--plan > li[data-drag]').first().boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + ((top.y + 4) - (g.y + g.height / 2)) * (i / 10));
    await page.mouse.up(); await page.waitForTimeout(300);
    await dismissReflow(page);
    const idx = await seqIdx();
    await page.click('[data-act="plan-edit-done"]'); await page.waitForTimeout(100);
    await page.click(`[data-lock="${target}"]`); await page.waitForTimeout(150);
    assert.match(await page.textContent('#toast'), /固定しました/);
    assert.equal(await page.locator(`[data-lock="${target}"].is-on`).count(), 1);
    await page.click('.replan [data-act="replan"]'); await accept(page); await page.waitForTimeout(600);
    assert.equal(await seqIdx(), idx, 'locked ride stays put after 更新');
    await page.screenshot({ path: `${SHOTS}/03-plan-lock.png`, fullPage: true });
    await page.click(`[data-lock="${target}"]`); await page.waitForTimeout(150);
    await page.click('.replan [data-act="replan"]'); await accept(page); await page.waitForTimeout(600);
  });
  await step('Plan stays put on its own; changes only on 更新', async () => {
    await tab(page, 'plan');
    const snapOf = () => page.$$eval('.tl--plan > li', (els) => els.map((e) => e.querySelector('.tl__time')?.textContent + (e.dataset.ride || '')).join('|'));
    const before = await snapOf();
    const at0 = await page.evaluate(() => window.__dlnavi.S.planSnap.at);
    await page.evaluate(() => { window.__dlnavi.S.sim.base += 45; });
    await tab(page, 'home'); await tab(page, 'plan');
    await page.click('#livePill'); await page.waitForTimeout(500);
    assert.equal(await snapOf(), before, 'time passing / tab switching / new waits do not reshuffle the plan');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planSnap.at), at0, 'saved plan untouched');
    await page.click('.tl__item--now [data-act="replan"]'); await accept(page); await page.waitForTimeout(600);
    assert.notEqual(await snapOf(), before, '更新 rebuilds from the current time');
    await page.evaluate(() => { window.__dlnavi.S.sim.base -= 45; });
    await page.click('.tl__item--now [data-act="replan"]'); await accept(page); await page.waitForTimeout(600);
  });
  await step('乗った keeps the order and re-times the rest from that moment', async () => {
    await tab(page, 'plan');
    const first = await page.getAttribute('.tl--plan > li[data-ride]', 'data-ride');
    const ids0 = await page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    await page.click(`.tl--plan [data-done="${first}"]`); await page.waitForTimeout(300);
    const now = await page.evaluate(() => window.__dlnavi.S.doneMin);
    const ids1 = await page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    // 乗った never reorders: the rest keeps exactly its order, only the times move
    const rest0 = ids0.filter((x) => x !== first);
    assert.deepEqual(ids1, rest0, '乗った keeps the order of the rest');
    const t0 = await page.textContent('.tl__item--now .tl__time');
    const t1 = await page.textContent('.tl--plan > li[data-ride]:not(.tl__item--paused) .tl__time');
    const toMin = (x) => { const m = String(x).match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }; // ignore brief ↑↓ move markers
    assert.ok(Math.abs(toMin(t0) - Math.floor(Object.values(now)[0])) <= 1, 'plan starts at the check-in time');
    assert.ok(Number.isFinite(toMin(t1)) && toMin(t1) >= toMin(t0), 'next operating ride is after check-in');
    assert.notEqual(await page.getAttribute('.tl--plan > li[data-ride]', 'data-ride'), first);
    assert.ok(ids0.length >= 2);
    await page.screenshot({ path: `${SHOTS}/03-plan-after-done.png` });
    await page.click(`.tl--done [data-done="${first}"]`); await page.waitForTimeout(150);
    await page.click(`[data-undo="${first}"]`); await page.waitForTimeout(200);
  });
  await step('9. Tap = complete; item stays visible as 完了; undo needs confirmation; survives reload', async () => {
    await tab(page, 'home');
    const first = await page.getAttribute('#actionbar [data-done]', 'data-done');
    await page.click('#actionbar [data-done]');
    await page.waitForTimeout(300);
    assert.match(await page.textContent('#toast'), /完了/);
    assert.equal(await page.evaluate((id) => !!window.__dlnavi.S.done[id], first), true, 'selected stop is complete');
    await page.reload(); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate((id) => !!window.__dlnavi.S.done[id], first), true, 'completion persisted');
    assert.notEqual(await page.getAttribute('#actionbar [data-done]', 'data-done'), first, 'next recommendation changes');
    await tab(page, 'plan');
    const doneRow = page.locator(`.tl--done [data-done="${first}"]`);
    assert.equal(await doneRow.count(), 1, 'completed item still listed');
    await doneRow.click(); await page.waitForTimeout(200);
    assert.equal(await page.isVisible('#sheet'), true, 'confirmation sheet');
    await page.screenshot({ path: `${SHOTS}/15-undo-confirm.png` });
    await page.click('#sheet button:has-text("そのまま")'); await page.waitForTimeout(150);
    assert.equal(await page.locator(`.tl--done [data-done="${first}"]`).count(), 1, 'still done after "そのまま"');
    // revert then restore from the toast
    await page.locator(`.tl--done [data-done="${first}"]`).click(); await page.waitForTimeout(150);
    await page.click(`[data-undo="${first}"]`); await page.waitForTimeout(200);
    assert.equal(await page.locator(`.tl--done [data-done="${first}"]`).count(), 0);
    assert.match(await page.textContent('#toast'), /未完了に戻しました/);
    await page.click('#toastAct'); await page.waitForTimeout(200);
    assert.equal(await page.locator(`.tl--done [data-done="${first}"]`).count(), 1, 'restored from toast');
    await page.screenshot({ path: `${SHOTS}/03-plan-done.png`, fullPage: true });
  });
  await step('10. Re-optimise after check-in keeps the remaining must-rides', async () => {
    await tab(page, 'plan');
    await page.click('[data-act="replan"]'); await accept(page);
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#toast'), /反映しました|最適です/);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    const st = await page.evaluate(() => window.__dlnavi.S.done);
    if (!st.falcon) assert.match(tl, /ファルコン/);
    if (!st.rise) assert.match(await page.textContent('.tl__item--paused'), /レジスタンス/);
  });
  await step('"別の候補" skips the current suggestion and shows feedback', async () => {
    await tab(page, 'home');
    const cur = await page.getAttribute('#actionbar [data-skip]', 'data-skip');
    await page.click('#actionbar [data-skip]');
    await page.waitForTimeout(250);
    const msg = await page.textContent('#toast');
    assert.match(msg, /あとまわし|後ろ|ほかの乗り物がありません/);
    // the next stop changes — unless the plan has no other ride (rides outside the plan are never made "next")
    if (!/ほかの乗り物がありません/.test(msg)) assert.notEqual(await page.getAttribute('#actionbar [data-skip]', 'data-skip') ?? 'anchor', cur);
    await page.screenshot({ path: `${SHOTS}/02-home-after-skip.png` });
  });
  await step('8. Photos: real image loads; broken image falls back to poster', async () => {
    await tab(page, 'explore');
    await page.waitForTimeout(500);
    const ok = await page.$eval('#view-explore [data-open="rise"] img', (i) => i.complete && i.naturalWidth > 0).catch(() => false);
    assert.ok(ok, 'rise photo loaded');
    assert.equal(await page.locator('#view-explore [data-open="indy"] img').count(), 0, 'broken indy image replaced');
    assert.equal(await page.locator('#view-explore [data-open="indy"] .poster').count(), 1);
    await page.screenshot({ path: `${SHOTS}/05-explore.png`, fullPage: true });
  });
  await step('Explore: filters/sort work and refurb closure is shown', async () => {
    await page.click('#view-explore [data-act="explore-filters"]'); await page.click('#sheet [data-filter-kind="down"]'); await page.click('#sheet [data-act="filters-apply"]'); await page.waitForTimeout(150);
    const t = await page.textContent('#view-explore .rows');
    assert.match(t, /スモールワールド|スモール・?ワールド|スモールワールド|イッツ・ア・スモールワールド/);
    assert.match(t, /リニューアル休止/);
    await page.click('#view-explore [data-act="explore-filters"]'); await page.click('#sheet [data-filter-kind="all"]'); await page.click('#sheet [data-act="filters-apply"]');
    await page.selectOption('[data-xsort]', 'wait'); await page.waitForTimeout(150);
    const waits = await page.$$eval('#view-explore .row__wait b', (b) => b.map((x) => parseInt(x.textContent)));
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1]);
    await page.click('[data-xtab="food"]'); await page.waitForTimeout(150);
    assert.ok(await page.locator('[data-open-food]').count() >= 10);
    await page.fill('#foodQ', 'ポップコーン'); await page.waitForTimeout(150);
    assert.ok(await page.locator('[data-open-food^="popcart-"]').count() >= 5, 'popcorn cart locations searchable');
    await page.fill('#foodQ', '');
    await page.screenshot({ path: `${SHOTS}/06-food.png`, fullPage: true });
    await page.click('[data-xtab="halloween"]'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#view-explore'), /ヴァンパイア・ミッキー/);
    await page.screenshot({ path: `${SHOTS}/07-halloween.png`, fullPage: true });
  });
  await step('Food search: keyword → matching shops nearest first, menu hits highlighted, map', async () => {
    await page.click('[data-xtab="food"]'); await page.waitForTimeout(150);
    await page.fill('#foodQ', 'チキン'); await page.waitForTimeout(150);
    const names = await page.$$eval('#foodList [data-open-food]', (els) => els.map((e) => e.dataset.openFood));
    assert.ok(names.includes('plazainn'), names.join(','));
    assert.ok(await page.locator('#foodList .fhit mark').count() >= 1, 'menu hit highlighted');
    assert.match(await page.textContent('.fbar'), /「チキン」\d+件/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'foodQ', 'typing keeps focus');
    await page.click('[data-fq="アイス"]'); await page.waitForTimeout(150);
    assert.ok(await page.locator('#foodList [data-open-food]').count() >= 1, 'synonym search (アイス → サンデー/ドールホイップ)');
    await page.screenshot({ path: `${SHOTS}/06-food-search.png` });
    await page.fill('#foodQ', 'ぜったいない料理'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#foodList'), /見つかりませんでした/);
    await page.fill('#foodQ', 'チキン'); await page.waitForTimeout(150);
    await page.click('[data-act="food-map"]'); await page.waitForTimeout(1500);
    assert.match(await page.textContent('#mapFoodChip'), /「チキン」の店/);
    assert.equal(await page.locator('.mk--food').count(), names.length, 'only matching shops on the map');
    await page.click('#mapFoodChip'); await page.waitForTimeout(300);
    await page.click('[data-mf="rides"]'); await page.waitForTimeout(200);
    await tab(page, 'explore');
    await page.fill('#foodQ', ''); await page.waitForTimeout(100);
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
  });
  await step('Detail sheet opens with description, Japan diff, manual wait input', async () => {
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
    await page.click('#view-explore [data-open="haunted"]'); await page.waitForTimeout(250);
    assert.equal(await page.isVisible('#sheet'), true);
    assert.match(await page.textContent('#sheet'), /日本との違い/);
    await page.click('#sheet summary:has-text("待ち時間を入力")');
    await page.fill('#manualWait', '15');
    await page.click('[data-manual-save="haunted"]'); await page.waitForTimeout(200);
    assert.match(await page.textContent('#toast'), /手入力/);
    assert.match(await page.textContent('#view-explore [data-open="haunted"]'), /15分[\s\S]*手入力/);
  });
  await step('Shows: times from API, toggle off removes from plan, pick 21:00 Fantasmic', async () => {
    if (await page.isVisible('#sheet')) await page.click('.sheet__close');
    await page.click('[data-xtab="shows"]'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#view-explore'), /公式/);
    await page.screenshot({ path: `${SHOTS}/08-shows.png`, fullPage: true });
    await page.click('[data-act="plan-edit-shows"]'); await page.waitForTimeout(200);
    await page.uncheck('[data-b-show-on="cavalcade"]'); await page.waitForTimeout(150);
    await page.click('[data-b-show-pick="fantasmic"][data-time="21:00"]'); await page.waitForTimeout(150);
    await page.click('[data-act="plan-apply"]'); await accept(page); await page.waitForTimeout(200);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    assert.doesNotMatch(tl, /カヴァルケード/);
    const fItem = await page.locator('.tl__item', { hasText: 'ファンタズミック' }).first().textContent();
    assert.match(fItem, /21:00/);
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.click('[data-b-tab="shows"]'); await page.waitForTimeout(100);
    await page.check('[data-b-show-on="cavalcade"]'); await page.waitForTimeout(100);
    await page.click('[data-b-show-pick="fantasmic"][data-time="22:30"]');
    await page.click('[data-act="plan-apply"]'); await accept(page); await page.waitForTimeout(200);
  });
  await step('Plan editing: remove, add back (best slot), drag dinner earlier', async () => {
    await tab(page, 'plan');
    const rides = () => page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    await page.click('[data-act="plan-edit-order"]'); await page.waitForTimeout(150);
    const before = await rides();
    const victim = before.find((x) => x !== 'rise' && x !== 'falcon');
    await page.click(`[data-rm="${victim}"]`); await page.waitForTimeout(200);
    assert.ok(!(await rides()).includes(victim), 'removed');
    assert.match(await page.textContent('#toast'), /外しました/);
    await page.click('[data-act="plan-edit-done"]'); await page.waitForTimeout(100);
    await page.click('[data-act="plan-add"]'); await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/03-plan-add.png` });
    await page.click(`#sheet [data-add="${victim}"]`); await page.waitForTimeout(300);
    assert.ok((await rides()).includes(victim), 'added back');
    assert.match(await page.textContent('#toast'), /追加しました/);
    await page.click('[data-act="plan-edit-order"]'); await page.waitForTimeout(100);
    // Editing shows a drag handle and removal button; no crowded ↑↓ arrow controls.
    const editable = () => page.locator('.tl--plan > li[data-drag]').evaluateAll((els) => els.map((e) => e.dataset.drag));
    const original = await editable();
    assert.ok(original.length >= 3, 'enough stops to reorder');
    assert.equal(await page.locator('[data-shift]').count(), 0, 'edit mode uses drag instead of arrows');
    assert.ok(await page.locator('[data-grip]').count() >= 3, 'drag handles are available');
    // drag dinner up above the ride before it → dinner gets earlier
    const dinnerT = async () => page.textContent('.tl--plan > li[data-drag="meal:dinner"] .tl__time');
    const toMin = (t) => { const [h, m] = t.replace(/[^\d:]/g, '').split(':').map(Number); return h * 60 + m; };
    const t0 = toMin(await dinnerT());
    const drags = await page.$$eval('.tl--plan > li[data-drag]', (els) => els.map((e) => e.dataset.drag));
    const di = drags.indexOf('meal:dinner');
    const above = drags[di - 2] || drags[0];
    await page.waitForTimeout(5600); // let the toast (with its button) go away
    await page.evaluate(() => { const r = document.querySelector('.tl--plan > li[data-drag="meal:dinner"]').getBoundingClientRect(); scrollBy(0, r.top - 380); });
    const g = await page.locator('[data-grip="meal:dinner"]').boundingBox();
    const tgt = await page.locator(`.tl--plan > li[data-drag="${above}"]`).boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, tgt.y + 5, { steps: 12 });
    await page.mouse.up(); await page.waitForTimeout(300);
    const t1 = toMin(await dinnerT());
    await dismissReflow(page);
    assert.ok(t1 < t0, `dinner earlier ${t0} → ${t1} ${drags.join()} toast=${await page.textContent("#toast")}`);
    await page.screenshot({ path: `${SHOTS}/03-plan-edit.png`, fullPage: true });
    await page.click('#toastAct'); await page.waitForTimeout(250); // undo
    assert.equal(toMin(await dinnerT()), t0, 'undo restores dinner time');
    await page.click('[data-act="plan-edit-done"]');
    assert.equal(await page.locator('[data-shift]').count(), 0, 'normal mode stays uncluttered');
  });
  await step('All attractions are listed (e.g. くまのプーさん) and can be added to the plan', async () => {
    await tab(page, 'explore');
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
    await page.click('#view-explore [data-act="explore-filters"]'); await page.click('#sheet [data-filter-kind="all"]'); await page.click('#sheet [data-act="filters-apply"]'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#view-explore [data-open="pooh"]').count(), 1, 'Pooh listed');
    await page.click('[data-xtab="greetings"]'); assert.ok(await page.locator('[data-open-ent]').count() >= 3);
    await page.click('[data-xtab="parades"]'); assert.ok(await page.locator('[data-open-ent]').count() >= 1);
    await page.click('[data-xtab="rides"]');
    await page.click('#view-explore [data-open="pooh"]'); await page.waitForTimeout(200);
    assert.match(await page.textContent('#sheet'), /プーさん/);
    await page.click('#sheet [data-add="pooh"][data-add-how="best"]'); await page.waitForTimeout(300);
    await tab(page, 'plan');
    assert.equal(await page.locator('.tl--plan > li[data-ride="pooh"]').count(), 1, 'Pooh in the plan');
    await page.click('[data-act="plan-edit-order"]'); await page.waitForTimeout(100);
    await page.click('[data-rm="pooh"]'); await page.waitForTimeout(200);
    await page.click('[data-act="plan-edit-done"]'); await page.waitForTimeout(100);
    await page.evaluate(() => { delete window.__dlnavi.S.excluded.pooh; });
  });
  await step('Plan editing: "次に行く" from a ride sheet; meal duration is adjustable', async () => {
    await tab(page, 'explore');
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
    await page.click('#view-explore [data-open="haunted"]'); await page.waitForTimeout(200);
    await page.click('#sheet [data-add="haunted"][data-add-how="next"]'); await page.waitForTimeout(300);
    await dismissReflow(page);
    await tab(page, 'home');
    assert.match(await page.textContent('.next__title'), /ホーンテッド/);
    await tab(page, 'plan');
    await page.locator('.tl__item--meal [data-anchor-edit]').first().click(); await page.waitForTimeout(200);
    await page.click('[data-meal-dur][data-v="90"]'); await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-meal-dur][data-v="90"].is-active').count(), 1);
    await page.click('.sheet .btn--navy[data-close]'); await page.waitForTimeout(150);
    const meal = await page.locator('.tl__item--meal .tl__meta').first().textContent();
    const m = meal.match(/(\d+):(\d+)–(\d+):(\d+)/);
    assert.ok(m, meal);
    assert.equal((+m[3] * 60 + +m[4]) - (+m[1] * 60 + +m[2]), 90, 'meal lasts 90 min');
    await page.locator('.tl__item--meal [data-anchor-edit]').first().click(); await page.waitForTimeout(200);
    await page.click('[data-meal-reset]'); await page.waitForTimeout(150);
    await page.locator('.replan [data-act="replan"]').click(); await accept(page); await page.waitForTimeout(600); // back to おすすめ順
  });
  await step('Meal can be changed visually (±15 min stepper + restaurant cards)', async () => {
    await tab(page, 'plan');
    await page.locator('.tl__item--meal [data-anchor-edit]').first().click(); await page.waitForTimeout(200);
    const before = await page.textContent('.stepper__v');
    await page.click('[data-meal-step][data-delta="15"]'); await page.waitForTimeout(150);
    assert.notEqual(await page.textContent('.stepper__v'), before);
    await page.click('[data-rest="ronto"]'); await page.waitForTimeout(150);
    assert.equal(await page.locator('.rest.is-active[data-rest="ronto"]').count(), 1);
    await page.screenshot({ path: `${SHOTS}/14-meal-editor.png` });
    await page.click('.sheet .btn--navy[data-close]'); await page.waitForTimeout(150);
    assert.match(await page.textContent('ol.tl:not(.tl--done)'), /ロント・ロースターズ/);
  });
  await step('Map renders markers and next-destination card', async () => {
    await tab(page, 'map'); await page.waitForTimeout(1500);
    assert.ok(await page.locator('.leaflet-marker-icon').count() >= 15);
    assert.match(await page.textContent('#mapcard'), /次の行き先|次の予定/);
    assert.ok((await page.locator('#mapcard').boundingBox()).height <= 64, 'compact destination bar');
    await page.screenshot({ path: `${SHOTS}/04-map.png` });
  });
  await step('Map: markers survive refreshes during zoom; location button is labelled', async () => {
    const n0 = await page.locator('.leaflet-marker-icon').count();
    assert.match(await page.textContent('[data-act="map-me"]'), /現在地を表示/);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__map.setZoom(window.__map.getZoom() + 0.5));
      await page.click('#livePill');
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.__map.setZoom(16));
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.leaflet-marker-icon').count(), n0, 'same number of pins');
    const visible = await page.$$eval('.leaflet-marker-icon', (els) => els.filter((e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0').length);
    assert.equal(visible, n0, 'all pins visible');
    await page.evaluate(() => window.__map.fitBounds([[33.8095, -117.9248], [33.8168, -117.9160]]));
  });
  await step('Map: restrooms are always shown; the restroom button picks one with walk + route', async () => {
    await tab(page, 'map'); await page.waitForTimeout(600);
    assert.ok(await page.locator('.mk--wc').count() >= 8, 'restroom pins (approximate fallback when OSM is unavailable)');
    await page.click('[data-mf="wc"]'); await page.waitForTimeout(400);
    assert.ok(await page.locator('.mk--wc.is-big').count() >= 8, 'トイレ filter enlarges them');
    await page.evaluate(() => { const S = window.__dlnavi.S; S.land = 'fantasy'; S.landAt = Date.now(); }); // where you are (area)
    await page.click('[data-act="map-wc"]'); await page.waitForTimeout(600);
    assert.equal(await page.locator('.mk--wc.is-target').count(), 1, 'one restroom chosen');
    assert.match(await page.textContent('#mapcard'), /トイレ/);
    assert.match(await page.getAttribute('#mapcard a[data-route]', 'href') || '', /google\.com\/maps\/dir\//);
    await page.screenshot({ path: `${SHOTS}/04-map-restroom.png` });
    await page.click('#mapcard [data-act="map-wc-clear"]'); await page.waitForTimeout(300);
    await page.click('[data-mf="rides"]'); await page.waitForTimeout(200);
  });
  await step('Island: from 15 min before leaving for the next meal/show, a capsule with the leave time; tap → actions', async () => {
    await tab(page, 'home');
    const base0 = await page.evaluate(() => window.__dlnavi.S.sim.base);
    const leave = await page.evaluate(() => { const d = window.__dlnavi; const it = d.S.planSnap.items.find((i) => (i.type === 'meal' || i.type === 'show') && !d.S.done[i.id]); return it.type === 'show' ? it.anchor.start - (it.anchor.claim || 0) : it.start; });
    await page.evaluate((m) => { window.__dlnavi.S.sim = { base: m - 30, setAt: Date.now() }; window.__dlnavi.renderAll(); }, leave);
    await page.waitForTimeout(200);
    assert.equal(await page.isVisible('#island'), false, 'not shown 30 min before');
    await page.evaluate((m) => { window.__dlnavi.S.sim = { base: m - 12, setAt: Date.now() }; window.__dlnavi.renderAll(); }, leave);
    await page.waitForTimeout(300);
    assert.equal(await page.isVisible('#island'), true, 'shown shortly before leaving');
    assert.match(await page.textContent('#island'), /\d{1,2}:\d{2}/);
    assert.ok((await page.textContent('#island')).replace(/\s+/g, '').length <= 24, 'a few words only');
    await page.screenshot({ path: `${SHOTS}/20-island.png` });
    await page.click('#island'); await page.waitForTimeout(250);
    assert.ok(await page.locator('#sheet a[data-route]').count() === 1, 'route from the island');
    await page.click('.sheet__close'); await page.waitForTimeout(150);
    await page.evaluate((b) => { window.__dlnavi.S.sim = { base: b, setAt: Date.now() }; window.__dlnavi.renderAll(); }, base0);
    await page.waitForTimeout(150);
  });
  await step('Alerts: reopened must-ride and a sudden wait drop are announced; 行く！ pins it', async () => {
    await tab(page, 'home');
    liveVariant = 1;
    await page.evaluate(() => { window.__dlnavi.S.sim.base += 15; });
    await page.click('#livePill'); await page.waitForTimeout(600);
    const t = await page.textContent('#view-home');
    assert.match(t, /レジスタンスの台頭 再開/);
    assert.match(t, /スペース・マウンテン 空いてきた/);
    await page.screenshot({ path: `${SHOTS}/16-alert.png` });
    await page.click('[data-pin="rise"]'); await page.waitForTimeout(300);
    await dismissReflow(page);
    assert.match(await page.textContent('.next__title'), /レジスタンス/);
    assert.match(await page.textContent('#actionbar'), /レジスタンス/);
    liveVariant = 0;
  });
  await step('Suggestion: a clearly better order is offered (not applied), 反映 shows ↑↓ on the rows', async () => {
    await tab(page, 'plan');
    const zig = ['space', 'thunder', 'mmrr', 'indy', 'startours', 'haunted', 'matterhorn', 'jungle'];
    await page.evaluate((z) => { const d = window.__dlnavi; const seq = d.S.planSnap.seq; const done = seq.filter((x) => d.S.done[x]); const anchors = seq.filter((x) => !d.S.done[x] && x.includes(':')); d.layoutPlan([...done, ...z.filter((x) => !d.S.done[x]), ...anchors], '並べ替え'); d.offerReflow('絶対の再開', [], { open: false }); d.renderAll(); }, zig);
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => window.__dlnavi.S.planSnap.seq.join());
    assert.equal(await page.locator('#view-plan .sugg-quiet').count(), 1, 'quiet suggestion');
    assert.doesNotMatch(await page.textContent('#view-plan .sugg-quiet'), /スペース・マウンテン|インディ/);
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planSnap.seq.join()), before, 'not applied on its own');
    assert.equal(await page.locator('#view-plan .sugg__t').count(), 0, 'times hidden until tapped');
    await page.screenshot({ path: `${SHOTS}/03-plan-suggest.png` });
    await page.click('#view-plan [data-act="suggest-preview"]'); await page.waitForTimeout(250);
    assert.ok(await page.locator('#sheet .pv__row').count() >= 3, 'preview timeline');
    assert.ok(await page.locator('#sheet .pv__row.is-moved').count() >= 1, 'moved rows highlighted');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planSnap.seq.join()), before, 'preview changes nothing');
    await page.screenshot({ path: `${SHOTS}/03-plan-suggest-preview.png` });
    await page.click('#sheet [data-act="suggest-apply"]'); await page.waitForTimeout(250);
    assert.notEqual(await page.evaluate(() => window.__dlnavi.S.planSnap.seq.join()), before);
    assert.ok(await page.locator('#view-plan .mv').count() >= 1, 'moved rows marked');
    assert.equal(await page.locator('#view-plan .sugg-quiet').count(), 0);
    await page.screenshot({ path: `${SHOTS}/03-plan-moved.png` });
    await page.click('#toastAct'); await page.waitForTimeout(200); // 元に戻す
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planSnap.seq.join()), before, 'undo');
    await page.click('.replan [data-act="replan"]'); await accept(page); await page.waitForTimeout(600);
  });
  await step('Position chip: pick the area you are in from the plan header', async () => {
    await tab(page, 'plan');
    await page.click('.tl__item--now [data-act="pick-land"]'); await page.waitForTimeout(200);
    await page.click('#sheet [data-land="frontier"]'); await page.waitForTimeout(250);
    assert.match(await page.textContent('.tl__item--now [data-act="pick-land"]'), /フロンティア/);
  });
  await step('Meals: every shop can be chosen for dinner (grouped), incl. Golden Horseshoe', async () => {
    await tab(page, 'plan');
    await page.click('.tl--plan [data-anchor-edit="meal:dinner"]'); await page.waitForTimeout(250);
    assert.equal(await page.locator('#sheet [data-rest="goldenhorseshoe"]').count(), 1, 'Golden Horseshoe');
    assert.equal(await page.locator('#sheet [data-rest="bluebayou"]').count(), 1, 'Blue Bayou');
    assert.ok(await page.locator('#sheet .restgrp').count() >= 3, 'grouped by kind');
    assert.ok(await page.locator('#sheet [data-rest]').count() >= 25, 'every shop');
    await page.screenshot({ path: `${SHOTS}/14b-dinner-shops.png`, fullPage: true });
    await page.click('#sheet [data-rest="goldenhorseshoe"]'); await page.waitForTimeout(250);
    assert.equal(await page.locator('#sheet [data-rest="goldenhorseshoe"].is-active').count(), 1);
    await page.click('#sheet .restcur'); await page.waitForTimeout(250);
    assert.match(await page.textContent('#sheetTitle'), /ゴールデン/);
    assert.ok(await page.locator('#sheet .menu--dish .dish__img').count() >= 2, 'each dish has a picture (or tile)');
    assert.match(await page.textContent('#sheet'), /公式メニュー/);
    await page.screenshot({ path: `${SHOTS}/06b-food-menu.png`, fullPage: true });
    await page.click('.sheet__backdrop', { position: { x: 10, y: 10 } }); await page.waitForTimeout(200);
  });
  await step('Pause: a planned ride that goes down stays in its place as 休止中 (order unchanged) and counts again on reopening', async () => {
    await tab(page, 'plan');
    const rides = () => page.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride));
    const seqOpen = () => page.evaluate(() => { const s = window.__dlnavi.S; return s.planSnap.seq.filter((x) => !s.done[x]); });
    await page.click('#livePill'); await page.waitForTimeout(600); // settle the current pauses first
    const before = await rides();
    const seq0 = await seqOpen();
    const manual = await page.evaluate(() => Object.keys(window.__dlnavi.S.manual || {}));
    const pick = before.find((x) => x !== 'rise' && x !== 'space' && !manual.includes(x));
    pauseId = pick;
    await page.click('#livePill'); await page.waitForTimeout(600);
    assert.deepEqual(await rides(), before, 'order unchanged, the paused ride stays in place');
    assert.equal(await page.locator(`.tl__item--paused[data-ride="${pick}"]`).count(), 1, 'marked 休止中 in place');
    assert.deepEqual(await seqOpen(), seq0, 'sequence unchanged');
    assert.match(await page.textContent('#toast'), /一時休止/);
    await tab(page, 'home');
    assert.notEqual(await page.getAttribute('#actionbar [data-done]', 'data-done'), pick, 'the next stop skips it');
    await tab(page, 'plan');
    await page.screenshot({ path: `${SHOTS}/03-plan-paused.png`, fullPage: true });
    pauseId = null;
    await page.click('#livePill'); await page.waitForTimeout(600);
    assert.deepEqual(await seqOpen(), seq0, 'sequence unchanged');
    assert.equal(await page.locator(`.tl__item--paused[data-ride="${pick}"]`).count(), 0, 'counts again');
    assert.deepEqual(await rides(), before);
    assert.match(await page.textContent('#toast'), /再開/);
  });
  await step('Trend: no sparkline in search; full trend only in details', async () => {
    await tab(page, 'explore');
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#view-explore .spark').count(), 0, 'the search list should stay compact');
    await page.click('#view-explore [data-open="space"]'); await page.waitForTimeout(250);
    assert.equal(await page.locator('.bigspark svg').count(), 1);
    await page.locator('.bigspark svg').scrollIntoViewIfNeeded();
    const box = await page.locator('.bigspark svg').boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.waitForTimeout(100);
    assert.match(await page.textContent('.bigspark__tip'), /推定/);
    await page.screenshot({ path: `${SHOTS}/17-trend-detail.png` });
    await page.click('.sheet__backdrop', { position: { x: 10, y: 10 } });
  });
  await step('Action bar: visible on home only; settings are switches', async () => {
    await tab(page, 'plan');
    assert.equal(await page.isVisible('#actionbar'), false);
    await tab(page, 'home');
    assert.equal(await page.isVisible('#actionbar'), true);
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#sheet [data-gps-toggle]').count(), 1);
    assert.equal(await page.locator('#sheet [data-act="reset"]').count(), 1);
    await page.screenshot({ path: `${SHOTS}/18-settings.png` });
    await page.click('.sheet__close'); await page.waitForTimeout(100);
  });
  await step('No emoji in the UI', async () => {
    for (const t of ['home', 'plan', 'explore']) {
      await tab(page, t);
      const txt = await page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(txt, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, t);
    }
  });
  await step('No uncaught JS errors', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- B: API failure ----------
{
  const { ctx, page, errors } = await newCtx({ liveMode: 'fail', photos: 'fail' });
  await step('6. API failure → error banner, 推定 labels, still recommends', async () => {
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#banner'), /推定/);
    assert.match(await page.textContent('#livePillText'), /推定/);
    assert.ok(await page.locator('.next .tag--est').count() >= 1);
    assert.equal(await page.locator('.next .tag--live').count(), 0, 'no LIVE label when not live');
    await page.click('[data-act="refresh"]'); await page.waitForTimeout(400);
    assert.match(await page.textContent('#toast'), /取得できませんでした/);
    await page.screenshot({ path: `${SHOTS}/09-api-failure.png` });
  });
  await step('8b. No photos → poster fallback everywhere', async () => {
    assert.equal(await page.locator('.next img').count(), 0);
    assert.equal(await page.locator('.next .poster').count(), 1);
  });
  await step('No uncaught JS errors (failure mode)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- B2: manual time can restart a plan without wiping progress ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('Manual start time changes future plan, survives refresh, and preserves done items', async () => {
    await page.click('#actionbar [data-done]');
    await tab(page, 'plan');
    const done = await page.locator('.tl--done .tl__item').count();
    await page.fill('#planTimeInput', '15:30');
    await page.click('[data-act="plan-time-set"]'); await accept(page);
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 930);
    assert.equal(await page.locator('.tl--done .tl__item').count(), done);
    await page.reload(); await page.waitForSelector('#planTimeInput');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 930);
    await page.click('[data-act="plan-edit"]');
    await page.fill('[data-b-start]', '16:15');
    await page.locator('[data-b-start]').dispatchEvent('change');
    await page.click('[data-act="plan-apply"]'); await accept(page);
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 975);
    await page.click('[data-act="plan-time-auto"]'); await accept(page);
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime), null);
  });
  await step('No JS errors in manual-time builder', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- B3: two phones share one plan ----------
{
  const A = await newCtx();
  const B = await newCtx();
  await step('Two phones: link join, 乗った and undo sync both ways, settings follow the newest change', async () => {
    await A.page.click('#settingsBtn'); await A.page.waitForTimeout(150);
    await A.page.click('[data-act="share-open"]'); await A.page.waitForTimeout(150);
    await A.page.click('[data-act="share-start"]'); await A.page.waitForTimeout(800);
    const code = await A.page.textContent('.sharecode b');
    assert.match(code, /^[a-z2-9]{8}$/);
    await A.page.screenshot({ path: `${SHOTS}/19-share.png` });
    await A.page.click('.sheet__close');
    await B.page.goto(base + '/#share=' + code); await B.page.waitForSelector('[data-share-join]');
    await B.page.click('[data-share-join]'); await B.page.waitForTimeout(800);
    assert.equal(await B.page.evaluate(() => window.__dlnavi.S.share.code), code);
    assert.match(await B.page.textContent('.planhead'), /共有中/);
    // A rides something → B sees it
    await A.page.click('.tab[data-tab="home"]'); await A.page.waitForTimeout(150);
    const rid = await A.page.getAttribute('#actionbar [data-done]', 'data-done');
    await A.page.click('#actionbar [data-done]'); await A.page.waitForTimeout(1200);
    await B.page.evaluate(() => window.__dlnavi.pullShare()); await B.page.waitForTimeout(300);
    assert.ok(await B.page.evaluate((id) => !!window.__dlnavi.S.done[id], rid), 'B got A\'s 乗った');
    assert.match(await B.page.textContent('#toast'), /相手の端末/);
    assert.equal(await B.page.locator(`.tl--done [data-done="${rid}"]`).count(), 1);
    // B changes the pace → A follows
    await B.page.click('[data-act="plan-edit"]'); await B.page.waitForTimeout(150);
    await B.page.click('[data-b-set="plan"][data-v="rides"]'); await B.page.click('[data-act="plan-apply"]'); await accept(B.page); await B.page.waitForTimeout(1200);
    await A.page.evaluate(() => window.__dlnavi.pullShare()); await A.page.waitForTimeout(300);
    assert.equal(await A.page.evaluate(() => window.__dlnavi.S.plan), 'rides');
    // Both phones show exactly the same plan (the saved plan itself is shared)
    const tlOf = (p) => p.$$eval('.tl--plan > li[data-ride]', (els) => els.map((e) => e.dataset.ride + '@' + e.querySelector('.tl__time').textContent.replace(/[^\d:休止]/g, '')).join(','));
    await A.page.click('.tab[data-tab="plan"]'); await B.page.click('.tab[data-tab="home"]'); await B.page.click('.tab[data-tab="plan"]'); await A.page.waitForTimeout(200);
    assert.equal(await tlOf(A.page), await tlOf(B.page), 'identical timelines');
    // A undoes → B drops it
    await A.page.click('.tab[data-tab="plan"]'); await A.page.waitForTimeout(150);
    await A.page.click(`.tl--done [data-done="${rid}"]`); await A.page.waitForTimeout(150);
    await A.page.click(`[data-undo="${rid}"]`); await A.page.waitForTimeout(1200);
    await B.page.evaluate(() => window.__dlnavi.pullShare()); await B.page.waitForTimeout(300);
    assert.ok(await B.page.evaluate((id) => !window.__dlnavi.S.done[id], rid), 'undo synced');
    await B.page.screenshot({ path: `${SHOTS}/19-share-partner.png`, fullPage: true });
    assert.deepEqual([...A.errors, ...B.errors], []);
  });
  await A.ctx.close(); await B.ctx.close();
}

// ---------- B4: a new deploy is picked up without closing the app ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('App update: new deploy → banner with 更新, tap reloads the new code', async () => {
    await page.waitForTimeout(3500); // first ETag snapshot
    let bump = true;
    await ctx.route('**/js/app.js', async (r) => {
      if (r.request().method() !== 'HEAD' || !bump) return r.continue();
      const res = await r.fetch();
      r.fulfill({ response: res, headers: { ...res.headers(), etag: '"new-deploy"' } });
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
    assert.match(await page.textContent('#banner'), /新しいバージョン/);
    bump = false;
    await Promise.all([page.waitForNavigation(), page.click('[data-act="app-update"]')]);
    await page.waitForSelector('.next__title');
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

// ---------- B5: free time before lunch still offers a route to the restaurant ----------
{
  const { ctx, page, errors } = await newCtx({ sim: '10:40' });
  await step('Free time: next stop (lunch) with ルート + メニュー on home and on the map card', async () => {
    await page.evaluate(() => {
      const S = window.__dlnavi.S;
      S.must = {}; S.excluded = Object.fromEntries(['rise','falcon','indy','space','haunted','thunder','mmrr','pirates','matterhorn','jungle','tiana','startours','smallworld','peterpan','toad','alice','buzz','autopia','nemo','tiki','marktwain','railroad'].map((k) => [k, true]));
      localStorage.setItem('dlnavi-1031-v1', JSON.stringify(S));
    });
    await page.reload(); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
    assert.match(await page.textContent('.next__title'), /ランチまで/);
    assert.match(await page.textContent('.nextstop'), /ランチ：/);
    assert.match(await page.getAttribute('.next a[data-route]', 'href'), /google\.com\/maps\/dir\//);
    assert.equal(await page.locator('.next [data-open-food]').first().count(), 1);
    await page.screenshot({ path: `${SHOTS}/12-free-time-route.png` });
    await tab(page, 'map'); await page.waitForTimeout(1200);
    assert.match(await page.textContent('#mapcard'), /ランチ/);
    assert.equal(await page.locator('#mapcard a[data-route]').count(), 1);
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

// ---------- C: GPS allowed ----------
{
  const { ctx, page, errors } = await newCtx({ geo: { latitude: 33.81185, longitude: -117.9214, accuracy: 15 } });
  await step('7a. GPS allowed → position used, distances shown', async () => {
    await page.evaluate(() => {
      const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
        window.__gpsCallback = ok;
        return original(ok, fail, options);
      };
      navigator.geolocation.watchPosition = () => { throw new Error('continuous tracking must not be used'); };
    });
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    await page.click('#sheet [data-act="pick-land"]'); await page.waitForTimeout(150);
    await page.click('[data-act="gps-start"]'); await page.waitForTimeout(800);
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#sheet .locrow'), /GPS/);
    await page.click('.sheet__close'); await page.waitForTimeout(100);
    assert.match(await page.textContent('#toast'), /現在地を取得/);
    await tab(page, 'map'); await page.waitForTimeout(1200);
    assert.equal(await page.locator('.mk--me').count(), 1);
    assert.equal(await page.locator('[data-act="map-me"].is-on').count(), 1, 'location button shows GPS on');
    assert.match(await page.textContent('#mapcard'), /\d+分/);
    const stable = await page.evaluate(() => {
      const before = document.querySelector('.mk--ride');
      for (let i = 0; i < 12; i++) {
        window.__gpsCallback({ coords: { latitude: 33.81185 + i * 0.000001, longitude: -117.9214, accuracy: 15 } });
      }
      return before === document.querySelector('.mk--ride');
    });
    assert.ok(stable, 'GPS jitter should not recreate map markers');
    await page.screenshot({ path: `${SHOTS}/04-map-gps.png` });
  });
  await step('Food search with GPS: nearest first, route starts from my position, in-app map to the shop', async () => {
    await tab(page, 'explore');
    await page.click('[data-xtab="food"]'); await page.waitForTimeout(150);
    await page.fill('#foodQ', 'チキン'); await page.waitForTimeout(200);
    assert.match(await page.textContent('.fbar'), /GPS/);
    const walks = await page.$$eval('#foodList [data-open-food]', (els) => els.map((e) => parseInt(e.textContent.match(/徒歩(\d+)分/)[1])));
    for (let i = 1; i < walks.length; i++) assert.ok(walks[i] >= walks[i - 1], 'nearest first');
    // long price must not squeeze the menu name into a vertical column
    const w = await page.$eval('#foodList [data-open-food="plazainn"] .fhit > span:first-child', (e) => e.getBoundingClientRect().width);
    assert.ok(w > 120, `menu name width ${w}`);
    await page.screenshot({ path: `${SHOTS}/06-food-search-gps.png` });
    await page.click('#foodList [data-open-food="plazainn"]'); await page.waitForTimeout(250);
    await page.click('[data-food-map="plazainn"]'); await page.waitForTimeout(1500);
    assert.equal(await page.locator('.mk--food.is-target').count(), 1);
    assert.match(await page.textContent('#mapcard'), /行き先[\s\S]*プラザ・イン[\s\S]*\d+分/);
    await page.screenshot({ path: `${SHOTS}/04-map-food.png` });
  });
  await step('ルート opens Google Maps walking directions from my GPS position', async () => {
    await tab(page, 'explore');
    await page.click('#foodList [data-open-food="plazainn"]'); await page.waitForTimeout(250);
    const href = await page.getAttribute('#sheet a[data-route]', 'href');
    assert.match(href, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=33\.8118\d+,-117\.921\d*&destination=/);
    assert.match(href, /travelmode=walking/);
    await page.click('.sheet__close'); await page.waitForTimeout(100);
    await tab(page, 'map');
    assert.match(await page.getAttribute('#mapcard a[data-route]', 'href'), /google\.com\/maps\/dir\/.*origin=/);
  });
  await step('No uncaught JS errors (GPS)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- D: GPS denied ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('7b. GPS denied → clear message + manual area picker works', async () => {
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: 'denied' }), 50); };
      navigator.geolocation.watchPosition = () => { throw new Error('continuous tracking must not be used'); };
    });
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    await page.click('#sheet [data-act="pick-land"]'); await page.waitForTimeout(150);
    await page.click('[data-act="gps-start"]'); await page.waitForTimeout(400);
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#sheet .locrow'), /許可されていません/);
    await page.click('#sheet [data-act="pick-land"]'); await page.waitForTimeout(200);
    await page.click('[data-land="tomorrow"]'); await page.waitForTimeout(200);
    await page.click('#settingsBtn'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#sheet .locrow'), /トゥモローランド/);
    await page.screenshot({ path: `${SHOTS}/10-gps-denied-land.png` });
  });
  await step('No uncaught JS errors (GPS denied)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- E: before opening / meal time / night ----------
for (const [t, expect, file] of [['07:00', /開園/, '11-preopen'], ['11:28', /ランチ/, '12-lunch'], ['21:00', /場所取り|花火|スクリームズ/, '13-night']]) {
  const { ctx, page, errors } = await newCtx({ sim: t });
  await step(`Time ${t}: home adapts (${expect})`, async () => {
    assert.match(await page.textContent('#view-home'), expect);
    if (t !== '07:00') assert.match(await page.getAttribute('.next a[data-route]', 'href') || '', /google\.com\/maps\/dir\//, 'next card has ルート');
    await page.screenshot({ path: `${SHOTS}/${file}.png` });
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

// ---------- G: when the plan changes (only on your own action) ----------
{
  const { ctx, page, errors } = await newCtx();
  const seq = () => page.evaluate(() => window.__dlnavi.S.planSnap.seq.join());
  await step('Rules: 今から作り直す is a proposal until 反映 — やめる keeps the plan exactly', async () => {
    await tab(page, 'plan');
    const s0 = await seq();
    await page.evaluate(() => { window.__dlnavi.S.sim.base += 150; });
    await page.click('.replan [data-act="replan"]'); await page.waitForTimeout(900);
    if (await page.locator('#sheet [data-act="proposal-apply"]').count()) {
      assert.match(await page.textContent('#sheet'), /作り直し案/);
      assert.ok(await page.locator('#sheet .pv__row').count() >= 1, 'compact before → after list');
      assert.equal(await seq(), s0, 'nothing changes while the proposal is open');
      await page.screenshot({ path: `${SHOTS}/19-proposal.png` });
      await page.click('#sheet [data-act="proposal-cancel"]'); await page.waitForTimeout(250);
      assert.equal(await seq(), s0, 'やめる keeps the plan');
      await page.click('.replan [data-act="replan"]'); await page.waitForTimeout(900);
      await page.click('#sheet [data-act="proposal-apply"]'); await page.waitForTimeout(300);
      assert.notEqual(await seq(), s0, '反映 applies it');
    } else {
      assert.match(await page.textContent('#toast'), /最適です/);
    }
    await page.evaluate(() => { window.__dlnavi.S.sim.base -= 150; });
  });
  await step('Rules: 絶対乗る on a ride sheet inserts only that ride; 乗らない removes only it', async () => {
    await tab(page, 'plan');
    const rides = async () => (await seq()).split(',').filter((x) => !x.includes(':'));
    const s0 = await rides();
    await tab(page, 'explore');
    const ids = await page.$$eval('#view-explore [data-open]', (els) => els.map((e) => e.dataset.open));
    const out = ids.find((x) => !s0.includes(x) && x !== 'rise' && x !== 'smallworld');
    await page.click(`#view-explore [data-open="${out}"]`); await page.waitForTimeout(250);
    await page.click(`#sheet [data-ride-st="${out}"][data-v="must"]`); await page.waitForTimeout(400);
    const s1 = await rides();
    assert.ok(s1.includes(out), 'inserted');
    assert.deepEqual(s1.filter((x) => x !== out), s0, 'nothing else changed');
    await page.click(`#sheet [data-ride-st="${out}"][data-v="skip"]`); await page.waitForTimeout(400);
    assert.deepEqual(await rides(), s0, 'removed again, rest unchanged');
    await page.evaluate(() => document.querySelector('.sheet__close')?.click()); await page.waitForTimeout(200);
  });
  await step('Rules: choosing your area does not reorder the plan', async () => {
    await tab(page, 'plan');
    const s0 = await seq();
    await page.click('.tl__item--now [data-act="pick-land"]'); await page.waitForTimeout(200);
    await page.click('#sheet [data-land="toon"]'); await page.waitForTimeout(300);
    assert.equal(await seq(), s0);
  });
  await step('Rules: free time is never filled on its own, and no unsolicited proposal appears', async () => {
    await tab(page, 'plan');
    // empty the evening: drop the evening rides from the plan by hand
    await page.evaluate(() => { const d = window.__dlnavi; const s = d.S.planSnap.seq; const keep = s.filter((x) => x.includes(':') || d.S.done[x]); d.layoutPlan(keep, '削除'); d.renderAll(); });
    await page.waitForTimeout(200);
    const s0 = await seq();
    await page.click('#livePill'); await page.waitForTimeout(600);
    assert.equal(await page.locator('#view-plan .sugg-quiet').count(), 0, 'no proposal from polling / free time');
    assert.equal(await seq(), s0, 'not added on its own');
    await tab(page, 'home');
    assert.equal(await page.evaluate(() => { const d = window.__dlnavi; return d.homeReco(d.ctx()).primary?.type; }), 'free', 'no ride outside the plan is made the next stop');
  });
  await step('No uncaught JS errors (rules)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- F: Disney California Adventure (park switch, trip day, map NEXT = plan) ----------
{
  const dcaLive = (variant = 0) => ({
    ok: true, park: 'dca', source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki', fetchedAt: new Date().toISOString(), errors: [],
    attractions: Object.fromEntries([
      ['rsr', variant ? 25 : 85], ['guardians', 55], ['webslingers', 40], ['incredicoaster', 35], ['soarin', 30], ['tsmm', 45],
      ['monsters', 15], ['luigi', 20], ['mermaid', 10], ['goofy', 20], ['swings', 10], ['palaround', 15], ['insideout', 10],
      ['mater', 10], ['turtle', 10], ['zephyr', 5], ['jessie', 5], ['grizzly', 25],
    ].map(([id, w]) => [id, { name: id, status: 'OPERATING', wait: w, lastUpdated: null, single: null }])),
    shows: {}, otherShows: [], matched: 18,
  });
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'America/Los_Angeles' });
  const isDca = (r) => new URL(r.request().url()).searchParams.get('park') === 'dca';
  await ctx.route('**/api/live*', (r) => { seen.push(r.request().url()); return r.fulfill({ json: isDca(r) ? dcaLive() : live() }); });
  await ctx.route('**/api/meta*', (r) => { seen.push(r.request().url()); return r.fulfill({ json: isDca(r) ? { ok: true, coords: {}, schedule: null, errors: [] } : meta }); });
  await ctx.route('**/api/photos*', (r) => r.fulfill({ json: { ok: true, photos: {} } }));
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('dlnavi-park')) localStorage.setItem('dlnavi-park', 'dl');
    for (const k of ['dlnavi-1031-v1', 'dlnavi-dca-v1']) if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ sim: { base: 600, setAt: Date.now() } }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/'); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
  const planTimes = () => page.$$eval('.tl--plan > li[data-drag]:not(.tl__item--paused) .tl__time', (els) => els.map((e) => { const [h, m] = e.textContent.replace(/[^\d:]/g, '').split(':').map(Number); return h * 60 + m; }));

  await step('DCA 1. Header switch ランド → カリフォルニア: DCA catalog, park=dca APIs, no horizontal scroll', async () => {
    assert.equal((await page.textContent('.parksw .is-active')).trim(), 'ランド');
    await page.click('.parksw [data-park="dca"]');
    await page.waitForSelector('.next__title'); await page.waitForTimeout(500);
    assert.equal((await page.textContent('.parksw .is-active')).trim(), 'カリフォルニア');
    assert.equal(await page.evaluate(() => window.__dlnavi.park), 'dca');
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundImage), /dca-(day|sunset|night)\.webp/, 'California skyline artwork');
    assert.ok(seen.some((u) => u.includes('/api/live?park=dca')) && seen.some((u) => u.includes('/api/meta?park=dca')), 'requests carry park=dca');
    const home = await page.textContent('#view-home');
    assert.doesNotMatch(home, /スター・ウォーズ|レジスタンス|ファルコン/);
    assert.ok(await page.evaluate(() => !!window.__dlnavi.ctx().must.rsr), 'Radiator Springs is the default must-ride');
    await noHScroll(page);
    await page.screenshot({ path: `${SHOTS}/20-dca-home.png` });
  });
  await step('DCA 2. Plan: 11/1 8:00→21:00, lunch, 18:30 ご褒美ディナー, World of Color', async () => {
    await tab(page, 'plan');
    assert.match(await page.textContent('.dayrow'), /11\/1（日）.*8:00.*21:00/);
    const t = await page.textContent('#view-plan');
    assert.match(t, /ラジエーター・スプリングス/); assert.match(t, /ランチ/); assert.match(t, /ご褒美ディナー/); assert.match(t, /ワールド・オブ・カラー/);
    const ids = await page.$$eval('.tl--plan > li[data-drag]', (els) => els.map((e) => e.dataset.drag));
    assert.ok(ids.includes('meal:dinner') && ids.includes('show:worldofcolor'), ids.join());
    await page.screenshot({ path: `${SHOTS}/21-dca-plan.png`, fullPage: true });
  });
  await step('DCA 3. Date / entry / exit: plan follows the new window; reset back to park hours', async () => {
    await page.click('.dayrow'); await page.waitForTimeout(200);
    assert.match(await page.textContent('#sheetBody'), /カリフォルニアの日程/);
    await page.screenshot({ path: `${SHOTS}/22-dca-day.png` });
    await page.fill('#dayEntry', '09:00'); await page.fill('#dayExit', '20:00');
    await page.click('[data-act="day-save"]'); await accept(page); await page.waitForTimeout(400);
    const h = await page.evaluate(() => window.__dlnavi.hours());
    assert.equal(h.open, 540); assert.equal(h.close, 1200);
    assert.match(await page.textContent('.dayrow'), /入園9:00.*退園20:00/);
    assert.doesNotMatch(await page.textContent('#view-plan'), /ワールド・オブ・カラー.*退園後/, 'no persistent after-exit banner');
    assert.equal(await page.locator('[data-drag="show:worldofcolor"]').count(), 0, 'show after explicit exit is omitted');
    const mins = await planTimes();
    assert.ok(mins.length && mins.every((m) => m < 1200), `timeline before 20:00: ${mins}`);
    // tapping the active park in the header opens the same sheet
    await page.click('.parksw [data-park="dca"]'); await page.waitForTimeout(200);
    await page.click('[data-act="day-reset"]'); await accept(page); await page.waitForTimeout(400);
    const h2 = await page.evaluate(() => window.__dlnavi.hours());
    assert.equal(h2.open, 480); assert.equal(h2.close, 1260);
  });
  await step('DCA 4. Map NEXT / route = home card target = plan, and follows plan changes', async () => {
    const homeNext = async () => { await tab(page, 'home'); return (await page.textContent('.next__title')).trim(); };
    const mapNext = async () => { await tab(page, 'map'); await page.waitForTimeout(900); return { n: (await page.textContent('.mapdest__n')).trim(), href: await page.getAttribute('#mapcard a[data-route]', 'href') }; };
    const h1 = await homeNext(); const m1 = await mapNext();
    assert.equal(m1.n, h1, 'map NEXT = home');
    // change the plan on home ("別の候補" moves it back) → the map follows
    await tab(page, 'home'); await page.click('.actionbar [data-skip]'); await page.waitForTimeout(400);
    const h2 = await homeNext(); const m2 = await mapNext();
    assert.notEqual(h2, h1); assert.equal(m2.n, h2, 'map follows the re-ordered plan'); assert.notEqual(m2.href, m1.href);
    // plan changed while the map stays open → card catches up without leaving the tab
    await page.evaluate(() => { const S = window.__dlnavi.S; window.__dlnavi.layoutPlan([...S.planSnap.seq].reverse(), '並べ替え'); });
    const want = await page.evaluate(() => { const r = window.__dlnavi.homeReco(window.__dlnavi.ctx()); return r.primary.a?.short || r.primary.anchor?.title || ''; });
    await page.evaluate(() => window.__dlnavi.renderMap()); await page.waitForTimeout(600);
    assert.match((await page.textContent('.mapdest__n')).trim(), new RegExp('^' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.screenshot({ path: `${SHOTS}/23-dca-map.png` });
  });
  await step('DCA 5. No Halloween tab; each park keeps its own progress', async () => {
    await tab(page, 'explore');
    assert.equal(await page.locator('[data-xtab="halloween"]').count(), 0);
    await tab(page, 'home');
    await page.click('.actionbar [data-done]'); await page.waitForTimeout(300);
    const dcaDone = Object.keys(await page.evaluate(() => window.__dlnavi.S.done));
    assert.ok(dcaDone.length >= 1);
    await page.click('.parksw [data-park="dl"]'); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__dlnavi.park), 'dl');
    const dlDone = Object.keys(await page.evaluate(() => window.__dlnavi.S.done));
    assert.ok(!dlDone.some((k) => dcaDone.includes(k)), 'progress is separate per park');
    await page.click('.parksw [data-park="dca"]'); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
    assert.deepEqual(Object.keys(await page.evaluate(() => window.__dlnavi.S.done)), dcaDone);
  });
  await step('No uncaught JS errors (DCA)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

await browser.close();
const fail = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);

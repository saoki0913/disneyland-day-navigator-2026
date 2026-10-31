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
const live = () => { const n = normalizeTPWLive(fx('tpw-live.json')); if (liveVariant === 1) { n.attractions.rise = { ...n.attractions.rise, status: 'OPERATING', wait: 40 }; n.attractions.space = { ...n.attractions.space, wait: 25 }; } return ({ ok: true, ...n, source: 'themeparks.wiki', sourceLabel: 'ThemeParks.wiki', fetchedAt: new Date().toISOString(), errors: [] }); };
const meta = { ok: true, coords: normalizeChildren(fx('tpw-children.json')), schedule: normalizeSchedule(fx('tpw-schedule.json')), errors: [] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEYQHqXc2zYwAAAABJRU5ErkJggg==', 'base64');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n   ', process.env.E2E_VERBOSE ? e.message : e.message.split('\n')[0]); }
}
const browser = await chromium.launch();
async function newCtx({ liveMode = 'ok', sim = '10:00', geo = null, photos = 'ok' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'America/Los_Angeles',
    ...(geo ? { geolocation: geo, permissions: ['geolocation'] } : {}),
  });
  await ctx.route('**/api/live', (r) => liveMode === 'ok' ? r.fulfill({ json: live() }) : r.fulfill({ status: 502, json: { ok: false, errors: ['themeparks.wiki: HTTP 503', 'queue-times.com: timeout'] } }));
  await ctx.route('**/api/meta', (r) => r.fulfill({ json: meta }));
  await ctx.route('**/api/photos*', (r) => photos === 'ok'
    ? r.fulfill({ json: { ok: true, photos: { rise: { src: 'https://upload.wikimedia.org/test/rise.png', page: 'https://commons.wikimedia.org/wiki/File:x', title: 'Rise', author: 'Test', license: 'CC BY 4.0', source: 'Wikimedia Commons' }, indy: { src: 'https://upload.wikimedia.org/test/broken.png', page: '', title: 'Indy', source: 'Wikimedia Commons' } } } })
    : r.fulfill({ status: 502, json: { ok: false } }));
  await ctx.route('https://upload.wikimedia.org/test/rise.png', (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await ctx.route('https://upload.wikimedia.org/test/broken.png', (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  const [h, m] = sim.split(':').map(Number);
  await ctx.addInitScript((v) => { if (!localStorage.getItem('dlnavi-1031-v1')) localStorage.setItem('dlnavi-1031-v1', JSON.stringify({ sim: { base: v, setAt: Date.now() } })); }, h * 60 + m);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.waitForSelector('.next__title');
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const tab = async (p, t) => { await p.click(`.tab[data-tab="${t}"]`); await p.waitForTimeout(250); };
const noHScroll = async (p) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');

// ---------- A: normal day with live data ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('1. iPhone size: home renders the Next Stop card, no horizontal scroll', async () => {
    const t = await page.textContent('.next__title');
    assert.ok(t.trim().length > 0);
    assert.ok(await page.evaluate(() => document.querySelector('.topbar').offsetHeight <= 60), 'slim header');
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
  await step('12. DOWN must-ride is flagged with reason (and not recommended now)', async () => {
    const notes = await page.textContent('#view-home');
    assert.match(notes, /レジスタンスの台頭：一時休止中/);
    assert.doesNotMatch(await page.textContent('.next__title'), /レジスタンス/);
  });
  await step('3/4. Plan builder: every pace keeps both Star Wars rides', async () => {
    await tab(page, 'plan');
    for (const id of ['relax', 'rides', 'balance']) {
      await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
      await page.click(`[data-b-set="plan"][data-v="${id}"]`); await page.waitForTimeout(150);
      assert.ok(await page.locator(`[data-b-set="plan"][data-v="${id}"].is-active`).count() === 1);
      await page.click('[data-act="plan-apply"]'); await page.waitForTimeout(200);
      const tl = await page.textContent('ol.tl:not(.tl--done)');
      assert.match(tl, /レジスタンスの台頭/, `${id} rise`);
      assert.match(tl, /ミレニアム・ファルコン/, `${id} falcon`);
      await page.screenshot({ path: `${SHOTS}/03-plan-${id}.png`, fullPage: true });
    }
    assert.match(await page.textContent('#toast'), /プランを作りました/);
  });
  await step('3b. Plan builder: conditions (must ride / skip ride / max wait) change the plan', async () => {
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.click('[data-b-ride="matterhorn"]'); await page.waitForTimeout(100); // → must
    assert.equal(await page.locator('[data-b-ride="matterhorn"].is-must').count(), 1);
    await page.click('[data-b-ride="pirates"]'); await page.click('[data-b-ride="pirates"]'); await page.waitForTimeout(100); // → skip
    assert.equal(await page.locator('[data-b-ride="pirates"].is-skip').count(), 1);
    await page.click('[data-b-set="maxWait"][data-v="30"]'); await page.waitForTimeout(100);
    await page.screenshot({ path: `${SHOTS}/03-plan-builder.png` });
    await page.click('[data-act="plan-apply"]'); await page.waitForTimeout(200);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    assert.match(tl, /マッターホーン/);
    assert.doesNotMatch(tl, /カリブの海賊/);
    assert.match(await page.textContent('.condsum'), /〜30分/);
    // restore
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.click('[data-b-ride="matterhorn"]'); await page.click('[data-b-ride="matterhorn"]');
    await page.click('[data-b-ride="pirates"]');
    await page.click('[data-b-set="maxWait"][data-v="60"]');
    await page.click('[data-act="plan-apply"]'); await page.waitForTimeout(200);
  });
  await step('11. Timeline: meals/shows appear once each, in time order, no overlap with rides', async () => {
    const items = await page.$$eval('ol.tl:not(.tl--done) .tl__item', (els) => els.map((e) => ({ t: e.querySelector('.tl__time').textContent, cls: e.className, name: e.querySelector('.tl__name')?.textContent || '' })));
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    for (let i = 1; i < items.length; i++) assert.ok(toMin(items[i].t) >= toMin(items[i - 1].t), `order ${items[i - 1].t} > ${items[i].t}`);
    const fant = items.filter((i) => /ファンタズミック/.test(i.name));
    assert.equal(fant.length, 1, 'Fantasmic once');
  });
  await step('9. Tap = complete; item stays visible as 完了; undo needs confirmation; survives reload', async () => {
    await tab(page, 'home');
    const first = await page.getAttribute('#actionbar [data-done]', 'data-done');
    await page.click('#actionbar [data-done]');
    await page.waitForTimeout(300);
    assert.match(await page.textContent('#toast'), /完了/);
    assert.match(await page.textContent('.prog__n'), /^1/);
    await page.reload(); await page.waitForSelector('.next__title'); await page.waitForTimeout(300);
    assert.match(await page.textContent('.prog__n'), /^1/);
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
    await page.click('[data-act="replan"]');
    await page.waitForTimeout(500);
    assert.match(await page.textContent('#toast'), /組み直/);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    const st = await page.evaluate(() => window.__dlnavi.S.done);
    for (const id of ['rise', 'falcon']) if (!st[id]) assert.match(tl, id === 'rise' ? /レジスタンス/ : /ファルコン/);
  });
  await step('"別の候補" skips the current suggestion and shows feedback', async () => {
    await tab(page, 'home');
    const cur = await page.getAttribute('#actionbar [data-skip]', 'data-skip');
    await page.click('#actionbar [data-skip]');
    await page.waitForTimeout(250);
    assert.match(await page.textContent('#toast'), /あとまわし/);
    assert.notEqual(await page.getAttribute('#actionbar [data-skip]', 'data-skip') ?? 'anchor', cur);
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
    await page.click('[data-xf="down"]'); await page.waitForTimeout(150);
    const t = await page.textContent('#view-explore .rows');
    assert.match(t, /スモールワールド|スモール・?ワールド|スモールワールド|イッツ・ア・スモールワールド/);
    assert.match(t, /リニューアル休止/);
    await page.click('[data-xf="all"]');
    await page.selectOption('[data-xsort]', 'wait'); await page.waitForTimeout(150);
    const waits = await page.$$eval('#view-explore .row__wait b', (b) => b.map((x) => parseInt(x.textContent)));
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1]);
    await page.click('[data-xtab="food"]'); await page.waitForTimeout(150);
    assert.ok(await page.locator('[data-open-food]').count() >= 10);
    await page.screenshot({ path: `${SHOTS}/06-food.png`, fullPage: true });
    await page.click('[data-xtab="halloween"]'); await page.waitForTimeout(150);
    assert.match(await page.textContent('#view-explore'), /ヴァンパイア・ミッキー/);
    await page.screenshot({ path: `${SHOTS}/07-halloween.png`, fullPage: true });
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
    await page.click('[data-act="plan-apply"]'); await page.waitForTimeout(200);
    const tl = await page.textContent('ol.tl:not(.tl--done)');
    assert.doesNotMatch(tl, /カヴァルケード/);
    const fItem = await page.locator('.tl__item', { hasText: 'ファンタズミック' }).first().textContent();
    assert.match(fItem, /21:00/);
    await page.click('[data-act="plan-edit"]'); await page.waitForTimeout(150);
    await page.check('[data-b-show-on="cavalcade"]'); await page.waitForTimeout(100);
    await page.click('[data-b-show-pick="fantasmic"][data-time="22:30"]');
    await page.click('[data-act="plan-apply"]'); await page.waitForTimeout(200);
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
    assert.match(await page.textContent('#mapcard'), /NEXT/);
    assert.ok((await page.locator('#mapcard').boundingBox()).height <= 64, 'compact destination bar');
    await page.screenshot({ path: `${SHOTS}/04-map.png` });
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
    assert.match(await page.textContent('.next__title'), /レジスタンス/);
    assert.match(await page.textContent('#actionbar'), /レジスタンス/);
    liveVariant = 0;
  });
  await step('Trend: history recorded → sparkline in list + chart in detail', async () => {
    await tab(page, 'explore');
    await page.click('[data-xtab="rides"]'); await page.waitForTimeout(150);
    assert.ok(await page.locator('#view-explore .spark').count() >= 5);
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
    await page.click('[data-act="plan-time-set"]');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 930);
    assert.equal(await page.locator('.tl--done .tl__item').count(), done);
    await page.reload(); await page.waitForSelector('#planTimeInput');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 930);
    await page.click('[data-act="plan-edit"]');
    await page.fill('[data-b-start]', '16:15');
    await page.locator('[data-b-start]').dispatchEvent('change');
    await page.click('[data-act="plan-apply"]');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime.base), 975);
    await page.click('[data-act="plan-time-auto"]');
    assert.equal(await page.evaluate(() => window.__dlnavi.S.planTime), null);
  });
  await step('No JS errors in manual-time builder', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- C: GPS allowed ----------
{
  const { ctx, page, errors } = await newCtx({ geo: { latitude: 33.81185, longitude: -117.9214, accuracy: 15 } });
  await step('7a. GPS allowed → position used, distances shown', async () => {
    await page.evaluate(() => {
      const original = navigator.geolocation.watchPosition.bind(navigator.geolocation);
      navigator.geolocation.watchPosition = (ok, fail, options) => {
        window.__gpsCallback = ok;
        return original(ok, fail, options);
      };
    });
    await page.click('[data-act="pick-land"]'); await page.waitForTimeout(150);
    await page.click('[data-act="gps-start"]'); await page.waitForTimeout(800);
    assert.match(await page.textContent('.locrow'), /GPS/);
    assert.match(await page.textContent('#toast'), /現在地を取得/);
    await tab(page, 'map'); await page.waitForTimeout(1200);
    assert.equal(await page.locator('.mk--me').count(), 1);
    assert.match(await page.textContent('#mapcard'), /徒歩\d+分/);
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
  await step('No uncaught JS errors (GPS)', async () => assert.deepEqual(errors, []));
  await ctx.close();
}

// ---------- D: GPS denied ----------
{
  const { ctx, page, errors } = await newCtx();
  await step('7b. GPS denied → clear message + manual area picker works', async () => {
    await page.evaluate(() => {
      navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: 'denied' }), 50); return 1; };
      navigator.geolocation.clearWatch = () => {};
    });
    await page.click('[data-act="pick-land"]'); await page.waitForTimeout(150);
    await page.click('[data-act="gps-start"]'); await page.waitForTimeout(400);
    assert.match(await page.textContent('.locrow'), /許可されていません/);
    await page.click('[data-act="pick-land"]'); await page.waitForTimeout(200);
    await page.click('[data-land="tomorrow"]'); await page.waitForTimeout(200);
    assert.match(await page.textContent('.locrow'), /トゥモローランド/);
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
    await page.screenshot({ path: `${SHOTS}/${file}.png` });
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

await browser.close();
const fail = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);

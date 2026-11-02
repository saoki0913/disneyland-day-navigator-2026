import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRecord, mergeRecords, recordFrom, recoverFromDoc, recoverFromTombstones, recordFromLegacyLog, recordStats } from '../public/js/records.js';
import { handleRecords } from '../lib/records-server.js';
import { pdfFromJpegs } from '../public/js/pdf.js';

// 2026-10-31 10:00 / 12:30 and 2026-11-01 09:00 in Anaheim (UTC-7)
const T1 = Date.parse('2026-10-31T17:00:00Z'), T2 = Date.parse('2026-10-31T19:30:00Z'), NEXT = Date.parse('2026-11-01T16:00:00Z');
const names = { rise: 'ライズ', falcon: 'ファルコン', 'meal:lunch': 'ランチ' };
const nameOf = (id) => names[id] || id;

test('recordFrom keeps what was done with its park time, in time order', () => {
  const r = recordFrom({ park: 'dl', date: '2026-10-31', done: { falcon: T2, rise: T1, 'meal:lunch': T2 }, doneMin: { rise: 600, falcon: 750 }, nameOf });
  assert.deepEqual(r.items.map((i) => [i.id, i.kind, i.min]), [['rise', 'ride', 600], ['falcon', 'ride', 750], ['meal:lunch', 'meal', 750]]);
  assert.equal(r.partial, false);
  assert.deepEqual(recordStats(r), { ride: 2, meal: 1, show: 0, total: 3, first: 600, last: 750 });
});

test('cleanRecord rejects bad parks, dates and ids; mergeRecords is a union that keeps known times', () => {
  assert.equal(cleanRecord({ park: 'xx', date: '2026-10-31', items: [{ id: 'rise' }] }), null);
  assert.equal(cleanRecord({ park: 'dl', date: '10/31', items: [{ id: 'rise' }] }), null);
  assert.equal(cleanRecord({ park: 'dl', date: '2026-10-31', items: [{ id: '<script>' }] }), null);
  const a = cleanRecord({ park: 'dl', date: '2026-10-31', items: [{ id: 'rise', name: 'ライズ', min: null }] });
  const b = cleanRecord({ park: 'dl', date: '2026-10-31', items: [{ id: 'rise', name: 'ライズ', min: 600, at: T1 }, { id: 'falcon', name: 'ファルコン', min: 700 }] });
  const m = mergeRecords(a, b);
  assert.deepEqual(m.items.map((i) => [i.id, i.min]), [['rise', 600], ['falcon', 700]]);
  assert.equal(m.partial, false);
  assert.deepEqual(mergeRecords(m, m), m);
});

test('recovery: done records still in a shared plan come back with their times', () => {
  const doc = { done: { rise: T1, falcon: NEXT }, doneMin: { rise: 600 }, doneDel: {} };
  const r = recoverFromDoc(doc, { park: 'dl', date: '2026-10-31', nameOf });
  assert.deepEqual(r.items.map((i) => [i.id, i.min]), [['rise', 600]]);
});

test('recovery: a new day\'s tombstones give back the ids (times unknown); same-day undos are ignored', () => {
  const doneDel = { rise: NEXT, falcon: NEXT + 5, 'meal:lunch': NEXT, haunted: T2 /* undone on the day */, later: NEXT + 2 * 86400e3 };
  const r = recoverFromTombstones(doneDel, { park: 'dl', date: '2026-10-31', nameOf });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['falcon', 'meal:lunch', 'rise']);
  assert.equal(r.partial, true);
  assert.equal(recoverFromTombstones({ rise: T2 }, { park: 'dl', date: '2026-10-31' }), null);
  const viaDoc = recoverFromDoc({ done: {}, doneDel }, { park: 'dl', date: '2026-10-31', nameOf });
  assert.equal(viaDoc.items.length, 3);
});

test('legacy on-device logs ({done, doneMin}) and merged bases are read as records', () => {
  const r = recordFromLegacyLog({ done: { rise: T1 }, doneMin: { rise: 600 }, base: { park: 'dl', date: '2026-10-31', items: [{ id: 'falcon', name: 'ファルコン', min: 540 }] } }, { park: 'dl', date: '2026-10-31', nameOf });
  assert.deepEqual(r.items.map((i) => [i.id, i.min]), [['falcon', 540], ['rise', 600]]);
});

test('/api/records: per-person backup, merged on save, never readable without sign-in', async () => {
  const store = new Map();
  const kv = {
    async get(k, o) { const v = store.get(k); return v == null ? null : o?.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
  const env = { SHARE: kv };
  const url = 'https://dl-navi-1031.pages.dev/api/records';
  const as = (email) => ({ identify: async () => email });
  const post = (rec, email = 'me@example.com') => handleRecords({ env, request: new Request(url, { method: 'POST', headers: { origin: 'https://dl-navi-1031.pages.dev', 'content-type': 'application/json' }, body: JSON.stringify({ record: rec }) }) }, as(email));
  const get = (email = 'me@example.com') => handleRecords({ env, request: new Request(url) }, as(email));

  assert.equal((await handleRecords({ env, request: new Request(url) }, as(null))).status, 401);
  assert.equal((await post({ park: 'dl', date: 'bad', items: [] })).status, 400);
  assert.equal((await post({ park: 'dl', date: '2026-10-31', items: [{ id: 'rise', name: 'ライズ', min: null }] })).status, 200);
  const r2 = await (await post({ park: 'dl', date: '2026-10-31', items: [{ id: 'rise', name: 'ライズ', min: 600 }, { id: 'falcon', name: 'ファルコン', min: 700 }] })).json();
  assert.deepEqual(r2.record.items.map((i) => [i.id, i.min]), [['rise', 600], ['falcon', 700]]);
  await post({ park: 'dca', date: '2026-11-01', items: [{ id: 'rsr', name: 'RSR', min: 540 }] });
  const mine = await (await get()).json();
  assert.deepEqual(mine.records.map((r) => `${r.park}:${r.date}`), ['dca:2026-11-01', 'dl:2026-10-31']);
  const other = await (await get('someone@example.com')).json();
  assert.deepEqual(other.records, [], 'one person never sees another person\'s days');
  assert.ok([...store.keys()].every((k) => !k.includes('@')), 'emails are not stored in keys');
  const bad = await handleRecords({ env, request: new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }) }, as('me@example.com'));
  assert.equal(bad.status, 403);
});

test('pdfFromJpegs writes a valid PDF skeleton with one image page per JPEG', async () => {
  const fake = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = pdfFromJpegs([fake, fake], 10, 20);
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 2);
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  // every xref offset points at "n 0 obj"
  const offs = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offs.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
});

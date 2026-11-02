// Day records ("思い出の記録") backed up per signed-in person, so a day's rides never vanish when a
// phone's storage is cleared, a home-screen app and Safari keep different storage, or the app is reset.
//
//   GET  /api/records            → { ok, records: [record, ...] }   (newest first)
//   POST /api/records { record } → { ok, record }                    (merged with what is stored)
//
// The person is identified only by the verified Cloudflare Access JWT (never by a header the
// caller chooses). KV keys use a SHA-256 of the email, never the address itself.
// A record holds what was done and when — never positions.
import { verifiedEmail } from './invite-server.js';
import { mergeRecords, cleanRecord, RECORD_PARKS } from '../public/js/records.js';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const MAX_BYTES = 48 * 1024;
const MAX_LIST = 120;

async function ownerKey(email) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('records:' + email));
  return 'rec:' + [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 40) + ':';
}

export async function handleRecords(ctx, { identify = verifiedEmail } = {}) {
  const email = await identify(ctx.request);
  if (!email) return reply({ ok: false, error: 'authentication-required' }, 401);
  const kv = ctx.env?.SHARE;
  if (!kv) return reply({ ok: false, error: 'storage-not-configured' }, 503);
  const prefix = await ownerKey(email);
  const method = ctx.request.method;

  if (method === 'GET') {
    const keys = [];
    let cursor;
    do {
      const page = await kv.list({ prefix, cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor && keys.length < MAX_LIST);
    const records = (await Promise.all(keys.slice(0, MAX_LIST).map((k) => kv.get(k, { type: 'json' }).catch(() => null))))
      .map(cleanRecord).filter(Boolean)
      .sort((a, b) => (b.date + b.park).localeCompare(a.date + a.park));
    return reply({ ok: true, records });
  }

  if (method === 'POST') {
    const origin = ctx.request.headers.get('origin');
    if (origin && origin !== new URL(ctx.request.url).origin) return reply({ ok: false, error: 'bad-origin' }, 403);
    const text = await ctx.request.text();
    if (text.length > MAX_BYTES) return reply({ ok: false, error: 'too-large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return reply({ ok: false, error: 'bad-json' }, 400); }
    const incoming = cleanRecord(body?.record);
    if (!incoming || !RECORD_PARKS.includes(incoming.park)) return reply({ ok: false, error: 'bad-record' }, 400);
    const key = `${prefix}${incoming.park}:${incoming.date}`;
    const cur = cleanRecord(await kv.get(key, { type: 'json' }).catch(() => null));
    const merged = cur ? mergeRecords(cur, incoming) : incoming;
    if (!cur || JSON.stringify(cur) !== JSON.stringify(merged)) {
      const out = JSON.stringify(merged);
      if (out.length > MAX_BYTES) return reply({ ok: false, error: 'too-large' }, 413);
      await kv.put(key, out); // kept until deleted: these are memories, not a cache
    }
    return reply({ ok: true, record: merged });
  }
  return reply({ ok: false, error: 'method-not-allowed' }, 405);
}

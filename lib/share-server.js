// Shared plan for two phones, stored in Workers KV (binding SHARE, namespace dl-navi-1031-share).
// Only plan settings and done records are stored — never positions. Rooms expire after 7 days.
import { json } from './server.js';
import { mergeDocs, sameDoc, emptyDoc, CODE_RE } from '../public/js/share.js';

const TTL = 7 * 86400;
const MAX_BYTES = 64 * 1024;
const key = (code) => 'room:' + code;

function room(ctx) {
  const code = String(ctx.params?.code || '').toLowerCase();
  if (!CODE_RE.test(code)) return { err: json({ ok: false, error: 'bad-code' }, 400) };
  if (!ctx.env?.SHARE) return { err: json({ ok: false, error: 'storage-not-configured' }, 503) };
  return { code, kv: ctx.env.SHARE };
}
async function read(kv, code) {
  const raw = await kv.get(key(code), { type: 'json' });
  return raw?.doc ? raw : null;
}

export async function handleShareGet(ctx) {
  const r = room(ctx);
  if (r.err) return r.err;
  const cur = await read(r.kv, r.code);
  return json({ ok: true, exists: !!cur, doc: cur?.doc || emptyDoc(), at: cur?.at || 0 });
}

// POST { doc } → merge into the stored document and return the merged result.
export async function handleSharePost(ctx) {
  const r = room(ctx);
  if (r.err) return r.err;
  const text = await ctx.request.text();
  if (text.length > MAX_BYTES) return json({ ok: false, error: 'too-large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
  const cur = await read(r.kv, r.code);
  const merged = mergeDocs(cur?.doc || emptyDoc(), body?.doc);
  let at = cur?.at || 0;
  if (!cur || !sameDoc(cur.doc, merged)) {
    at = Date.now();
    const out = JSON.stringify({ doc: merged, at });
    if (out.length > MAX_BYTES) return json({ ok: false, error: 'too-large' }, 413);
    await r.kv.put(key(r.code), out, { expirationTtl: TTL });
  }
  return json({ ok: true, exists: true, doc: merged, at });
}

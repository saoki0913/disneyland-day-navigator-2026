// Two-person plan sharing: a small, DOM-free merge model used by both the phone and the server.
//
// Shared document:
//   { v: 1,
//     done:    { id: completedAtMs },   // "乗った／食べた／観た"
//     doneMin: { id: parkMinutes },     // completion time shown on the plan
//     doneDel: { id: undoneAtMs },      // "未完了に戻す" (tombstone)
//     f:       { field: { at: ms, v: value } } }   // plan settings, last writer wins per field
//
// Merging is commutative and idempotent, so two phones that push at the same time
// still converge: completions are a union (an undo wins only if it is newer), and every
// setting keeps the most recent change.
export const SHARE_FIELDS = ['plan', 'cond', 'must', 'excluded', 'order', 'prefs', 'manual'];
export const CODE_RE = /^[a-z2-9]{8}$/;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)];
  return s;
}

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const num = (x) => (Number.isFinite(x) ? x : 0);

export function emptyDoc() { return { v: 1, done: {}, doneMin: {}, doneDel: {}, f: {} }; }

export function mergeDocs(a, b) {
  a = { ...emptyDoc(), ...obj(a) }; b = { ...emptyDoc(), ...obj(b) };
  const out = emptyDoc();
  const ids = new Set([...Object.keys(obj(a.done)), ...Object.keys(obj(b.done)), ...Object.keys(obj(a.doneDel)), ...Object.keys(obj(b.doneDel))]);
  for (const id of ids) {
    const ta = num(a.done[id]), tb = num(b.done[id]);
    const del = Math.max(num(a.doneDel[id]), num(b.doneDel[id]));
    if (del) out.doneDel[id] = del;
    const t = Math.max(ta, tb);
    if (t && t > del) {
      out.done[id] = t;
      const min = ta >= tb ? a.doneMin[id] ?? b.doneMin[id] : b.doneMin[id] ?? a.doneMin[id];
      if (Number.isFinite(min)) out.doneMin[id] = min;
    }
  }
  for (const k of SHARE_FIELDS) {
    const fa = obj(a.f)[k], fb = obj(b.f)[k];
    // Newest change wins; an exact tie is broken by content so both sides pick the same one.
    const pick = !fa ? fb : !fb ? fa : num(fb.at) !== num(fa.at) ? (num(fb.at) > num(fa.at) ? fb : fa) : (stable(fb.v) > stable(fa.v) ? fb : fa);
    if (pick) out.f[k] = { at: num(pick.at), v: pick.v ?? null };
  }
  return out;
}

// Stable comparison (key order independent) to know whether a merge changed anything.
export function sameDoc(a, b) { return stable(a) === stable(b); }
function stable(x) {
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
  return JSON.stringify(x ?? null);
}

// Invitation API for the private Park Navi only.
// Access JWT is verified cryptographically; never trust a caller-provided email header.
import { CODE_RE } from '../public/js/share.js';

export const OWNER = 'shunsuke.aoki0913@gmail.com';
export const ACCOUNT = '97d97fcd567c4df4ab03b360f4cfe61d';
export const POLICY = '064ba523-c975-47a9-9435-6b071f47315e';
export const TEAM = 'quiet-sun-bc4b.cloudflareaccess.com';
export const AUD = {
  production: '6e2cad1cadef46ccc00b862b94d48a8ac3dde10b15805ec598864656e40e4d63',
  preview: '5d88e3af8ed8e6c019160e135ca1f9d7c152211501cd3ff26709fc1e4d99b0b8'
};

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
export const normalizeEmail = value => String(value || '').trim().toLowerCase();
export const validEmail = value => /^[^\\s@]{1,64}@[^\\s@]{1,190}\\.[a-z]{2,}$/i.test(value) && value.length <= 254;
const decode64 = value => {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, x => x.charCodeAt(0));
};
const parse64 = value => JSON.parse(new TextDecoder().decode(decode64(value)));

export async function verifiedEmail(request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    const aud = hostname === 'dl-navi-1031.pages.dev' ? AUD.production
      : /^[a-z0-9-]+\\.dl-navi-1031\\.pages\\.dev$/.test(hostname) ? AUD.preview : null;
    if (!aud) return null; // Local development never impersonates a logged-in user.
    const jwt = request.headers.get('cf-access-jwt-assertion') || '';
    if (jwt.length > 12000) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    const head = parse64(parts[0]), payload = parse64(parts[1]);
    if (head.alg !== 'RS256' || !head.kid) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== `https://${TEAM}` || ![payload.aud].flat().includes(aud)
        || !Number.isFinite(payload.exp) || payload.exp <= now
        || (payload.nbf != null && payload.nbf > now) || !validEmail(normalizeEmail(payload.email))) return null;
    const certs = await fetch(`https://${TEAM}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
    if (!certs.ok) return null;
    const keySet = await certs.json();
    const jwk = keySet.keys?.find(k => k.kid === head.kid && k.kty === 'RSA');
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(parts[2]), signed);
    return valid ? normalizeEmail(payload.email) : null;
  } catch { return null; }
}
async function emailKey(email) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeEmail(email)));
  return 'invite:email:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin && origin === new URL(request.url).origin;
}
export async function handleInviteMe(ctx) {
  const email = await verifiedEmail(ctx.request);
  if (!email) return reply({ ok: false, error: 'authentication-required' }, 401);
  if (!ctx.env?.SHARE) return reply({ ok: false, error: 'storage-not-configured' }, 503);
  const roomCode = await ctx.env.SHARE.get(email === OWNER ? 'invite:owner' : await emailKey(email));
  return reply({ ok: true, isOwner: email === OWNER, roomCode: CODE_RE.test(roomCode || '') ? roomCode : null });
}
export async function handleInvite(ctx) {
  const email = await verifiedEmail(ctx.request);
  if (email !== OWNER) return reply({ ok: false, error: 'owner-only' }, 403);
  if (!sameOrigin(ctx.request) || ctx.request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return reply({ ok: false, error: 'bad-origin-or-content-type' }, 403);
  if (!ctx.env?.SHARE || !ctx.env?.ACCESS_POLICY_API_TOKEN)
    return reply({ ok: false, error: 'invite-configuration-missing' }, 503);
  const content = await ctx.request.text();
  if (content.length > 4096) return reply({ ok: false, error: 'too-large' }, 413);
  let args;
  try { args = JSON.parse(content); } catch { return reply({ ok: false, error: 'bad-json' }, 400); }
  const invitee = normalizeEmail(args?.email);
  const roomCode = String(args?.roomCode || '').toLowerCase();
  if (!validEmail(invitee) || invitee === OWNER || !CODE_RE.test(roomCode))
    return reply({ ok: false, error: 'invalid-invitation' }, 400);
  const kv = ctx.env.SHARE;
  const ownerRoom = await kv.get('invite:owner');
  if (ownerRoom && ownerRoom !== roomCode) return reply({ ok: false, error: 'owner-room-mismatch' }, 409);
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/policies/${POLICY}`;
  const auth = { Authorization: `Bearer ${ctx.env.ACCESS_POLICY_API_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    // Do not modify arbitrary policies. Never let an invitee grant invitations.
    const currentRes = await fetch(api, { headers: auth });
    const current = await currentRes.json();
    if (!currentRes.ok || !current.success || current.result?.name !== 'Park Navi - allowed email addresses'
       || current.result?.decision !== 'allow') return reply({ ok: false, error: 'access-policy-unavailable' }, 502);
    const currentEmails = (current.result.include || []).map(x => normalizeEmail(x.email?.email)).filter(Boolean);
    if (!currentEmails.includes(OWNER) || (current.result.include || []).some(x => !x.email?.email))
      return reply({ ok: false, error: 'unexpected-policy-rules' }, 409);
    if (!currentEmails.includes(invitee)) {
      // Include rules are OR rules; preserve all existing email addresses.
      const updated = await fetch(api, {
        method: 'PUT', headers: auth, body: JSON.stringify({
          name: current.result.name, decision: 'allow', session_duration: current.result.session_duration || '720h',
          include: [...new Set([...currentEmails, invitee])].map(e => ({ email: { email: e } })),
          require: current.result.require || [], exclude: current.result.exclude || []
        })
      });
      const update = await updated.json();
      if (!updated.ok || !update.success) return reply({ ok: false, error: 'access-policy-update-failed' }, 502);
    }
    // Persistent association: after OTP login the invitee joins the owner's plan automatically.
    await kv.put(await emailKey(invitee), roomCode);
    if (!ownerRoom) await kv.put('invite:owner', roomCode);
    return reply({ ok: true, email: invitee, joinUrl: new URL('/', ctx.request.url).href });
  } catch {
    return reply({ ok: false, error: 'invitation-unavailable' }, 502);
  }
}

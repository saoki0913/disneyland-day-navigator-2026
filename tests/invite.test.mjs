import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, validEmail, verifiedEmail, handleInvite, handleInviteMe, OWNER } from '../lib/invite-server.js';

test('invite emails are normalized and validated', () => {
  assert.equal(normalizeEmail('  Partner@Example.com '), 'partner@example.com');
  assert.equal(validEmail('partner@example.com'), true);
  assert.equal(validEmail('invalid'), false);
  assert.equal(validEmail('foo@example.com.evil user'), false);
});
test('invitation routes fail closed without a valid Access JWT', async () => {
  const req = new Request('https://dl-navi-1031.pages.dev/api/invite', {
    method: 'POST', headers: { origin: 'https://dl-navi-1031.pages.dev', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'partner@example.com', roomCode: 'abcdefgh' })
  });
  const ctx = { request: req, env: { SHARE: { put() { throw Error('must not touch KV'); } }, ACCESS_POLICY_API_TOKEN: 'not-used' } };
  assert.equal((await handleInvite(ctx)).status, 403);
  assert.equal((await handleInviteMe({ ...ctx, request: new Request('https://dl-navi-1031.pages.dev/api/invite/me') })).status, 401);
  assert.equal(await verifiedEmail(new Request('https://unrelated.pages.dev/api/invite/me', {
    headers: { 'cf-access-jwt-assertion': 'fake.header.signature' }
  })), null);
  assert.equal(OWNER, 'shunsuke.aoki0913@gmail.com');
});

test('verified owner can invite an email and recipient resolves the same room', async () => {
  const { webcrypto } = await import('node:crypto');
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const pub = await webcrypto.subtle.exportKey('jwk', publicKey);
  pub.kid = 'invite-test-key';
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const issued = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', kid: pub.kid });
  const { AUD, TEAM } = await import('../lib/invite-server.js');
  const makeToken = async email => {
    const payload = b64({ iss: 'https://' + TEAM, aud: AUD.production, email, exp: issued + 1800, iat: issued });
    const signed = header + '.' + payload;
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signed));
    return signed + '.' + Buffer.from(sig).toString('base64url');
  };
  const ownerToken = await makeToken(OWNER);
  const partnerToken = await makeToken('partner@example.com');
  const origin = 'https://dl-navi-1031.pages.dev';
  const storage = new Map();
  const kv = { async get(key) { return storage.get(key) || null; }, async put(key, val) { storage.set(key, val); } };
  const originalFetch = globalThis.fetch;
  let updatedPolicy = null;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/cdn-cgi/access/certs'))
      return new Response(JSON.stringify({ keys: [pub] }), { status: 200 });
    if (String(url).endsWith('/access/policies/064ba523-c975-47a9-9435-6b071f47315e')) {
      if (opts.method === 'PUT') {
        updatedPolicy = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true, result: updatedPolicy }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: {
        name: 'Park Navi - allowed email addresses', decision: 'allow', include: [{ email: { email: OWNER } }],
        session_duration: '720h'
      } }), { status: 200 });
    }
    throw new Error('Unexpected outbound call: ' + url);
  };
  try {
    const ownerCtx = { env: { SHARE: kv, ACCESS_POLICY_API_TOKEN: 'test-token-not-secret' },
      request: new Request(origin + '/api/invite', { method: 'POST', headers: {
        origin, 'content-type': 'application/json', 'cf-access-jwt-assertion': ownerToken
      }, body: JSON.stringify({ email: ' Partner@Example.com ', roomCode: 'abcdefgh' }) }) };
    const reply = await handleInvite(ownerCtx);
    assert.equal(reply.status, 200, await reply.text());
    assert.deepEqual(updatedPolicy.include.map(x => x.email.email), [OWNER, 'partner@example.com']);
    assert.equal(storage.get('invite:owner'), 'abcdefgh');
    const partnerCtx = { env: { SHARE: kv }, request: new Request(origin + '/api/invite/me', {
      headers: { 'cf-access-jwt-assertion': partnerToken }
    }) };
    const me = await (await handleInviteMe(partnerCtx)).json();
    assert.equal(me.roomCode, 'abcdefgh');
    assert.equal(me.isOwner, false);
    const outsiderAttempt = await handleInvite({ ...ownerCtx, request: new Request(origin + '/api/invite', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-access-jwt-assertion': partnerToken },
      body: JSON.stringify({ email: 'other@example.com', roomCode: 'abcdefgh' })
    }) });
    assert.equal(outsiderAttempt.status, 403);
  } finally { globalThis.fetch = originalFetch; }
});

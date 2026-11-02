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

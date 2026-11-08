import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatGPT, verifyIdentity } from '../lib/chatgpt.mjs';
import { createAI } from '../lib/ai.mjs';
import { readCompletedResponse } from '../lib/response-stream.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
const signed = claims => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
};
const fullScope = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';

async function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worknote-auth-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  let clock = Date.now(), authorization, refreshes = 0, revokeFails = false;
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url.endsWith('/jwks.json')) return Response.json(jwks);
    if (url.endsWith('/oauth/token')) {
      const fields = new URLSearchParams(options.body);
      if (fields.get('grant_type') === 'refresh_token') refreshes++;
      else {
        assert.equal(fields.get('client_id'), 'oaiapp_TEST');
        assert.equal(fields.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
        assert.equal(fields.get('resource'), 'https://api.openai.com/v1');
        assert.ok(fields.get('code_verifier'));
      }
      return Response.json({ token_type: 'Bearer', access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600, scope: overrides.scope ?? fullScope, id_token: signed({ iss: 'https://auth.openai.com', aud: 'oaiapp_TEST', sub: overrides.subject ?? 'subject-A', email: 'tester@example.com', exp: Math.floor(clock / 1000) + 3600, iat: Math.floor(clock / 1000), nonce: authorization.searchParams.get('nonce') }) });
    }
    if (url.endsWith('/v1/models')) return Response.json({ models: [{ slug: 'available-model', display_name: 'Available model', visibility: 'list' }, { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' }] });
    if (url.endsWith('/revoke')) return new Response(null, { status: revokeFails ? 500 : 200 });
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const auth = createChatGPT({ file, port: 3000, fetcher, now: () => clock });
  async function begin(accountId) { authorization = new URL((await auth.begin(accountId)).authorizationUrl); return authorization; }
  async function finish(extra = {}) {
    const params = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'test-code', client_id: 'oaiapp_TEST', ...extra });
    return auth.callback(params);
  }
  return { auth, file, calls, begin, finish, advance: ms => { clock += ms; }, refreshes: () => refreshes, revokeFails: () => { revokeFails = true; }, reload: () => createChatGPT({ file, port: 3000, fetcher, now: () => clock }) };
}

test('OAuth uses new state, nonce and PKCE, with a persistent host ID and exact loopback callback', async t => {
  const f = await setup(t);
  const first = await f.begin();
  const second = await f.begin();
  assert.equal(first.origin, 'https://auth.openai.com');
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), 'Worknote');
  assert.equal(first.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.notEqual(first.searchParams.get('nonce'), second.searchParams.get('nonce'));
  assert.notEqual(first.searchParams.get('code_challenge'), second.searchParams.get('code_challenge'));
  assert.equal(first.searchParams.get('ext_agent_host_id'), second.searchParams.get('ext_agent_host_id'));
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
});

test('callback validates identity and stores credentials without exposing them through status', async t => {
  const f = await setup(t);
  await f.begin(); await f.finish();
  const status = f.auth.status();
  assert.equal(f.auth.configured, true);
  assert.equal(status.active.email, 'tester@example.com');
  assert.equal(status.active.planEnabled, true);
  for (const secret of ['access-0', 'refresh-0', 'id_token', 'subject-A', 'oaiapp_TEST']) assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.parse(readFileSync(f.file)).accounts[0].client_id, 'oaiapp_TEST');
  assert.equal(f.reload().status().active.email, status.active.email);
});

test('missing, replayed and expired OAuth states are rejected before token exchange', async t => {
  const f = await setup(t);
  await assert.rejects(f.auth.callback(new URLSearchParams({ state: 'wrong', code: 'bad' })), /expired/);
  await f.begin(); await f.finish();
  await assert.rejects(f.finish(), /already used/);
  await f.begin(); f.advance(600001);
  await assert.rejects(f.finish(), /expired/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('declining authorization does not change the active account', async t => {
  const f = await setup(t);
  await f.begin(); await f.finish();
  const before = f.auth.status().active.id;
  await f.begin();
  await assert.rejects(f.finish({ error: 'access_denied' }), /declined/);
  assert.equal(f.auth.status().active.id, before);
});

test('identity verification rejects wrong nonce, issuer, audience, expiry and unsigned tokens', () => {
  const base = { iss: 'https://auth.openai.com', aud: 'oaiapp_TEST', sub: 'subject', nonce: 'nonce', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const expected = { clientId: 'oaiapp_TEST', nonce: 'nonce' };
  assert.equal(verifyIdentity(signed(base), jwks, expected).sub, 'subject');
  for (const change of [{ nonce: 'wrong' }, { iss: 'https://evil.example' }, { aud: 'other' }, { exp: 1 }, { sub: '' }, { iat: base.iat + 9999 }]) assert.throws(() => verifyIdentity(signed({ ...base, ...change }), jwks, expected), /verification failed/);
  assert.throws(() => verifyIdentity('eyJhbGciOiJub25lIn0.e30.', jwks, expected), /verification failed/);
  const valid = signed(base).split('.');
  valid[1] = Buffer.from(JSON.stringify({ ...base, sub: 'attacker' })).toString('base64url');
  assert.throws(() => verifyIdentity(valid.join('.'), jwks, expected), /verification failed/);
});

test('plan permission is separate from successful identity sign-in', async t => {
  const f = await setup(t, { scope: 'openid profile email' });
  await f.begin(); await f.finish();
  assert.equal(f.auth.status().active.connected, true);
  assert.equal(f.auth.configured, false);
  await assert.rejects(f.auth.models(), /not authorized/);
});

test('available models are account-specific and an unlisted slug is rejected', async t => {
  const f = await setup(t); await f.begin(); await f.finish();
  const available = await f.auth.models();
  assert.deepEqual(available, [{ id: 'available-model', name: 'Available model' }]);
  await assert.rejects(f.auth.selectModel('hidden-model'), /available/);
  await f.auth.selectModel('available-model');
  assert.equal((await f.auth.inferenceCredentials()).model, 'available-model');
});

test('returning sign-in reuses the client and host rather than dynamically registering again', async t => {
  const f = await setup(t); const first = await f.begin(); await f.finish();
  const returned = await f.begin(f.auth.status().active.id);
  assert.equal(returned.searchParams.get('client_id'), 'oaiapp_TEST');
  assert.equal(returned.searchParams.has('agent_name_hint'), false);
  assert.equal(returned.searchParams.has('id_token_hint'), false);
  assert.equal(first.searchParams.get('ext_agent_host_id'), returned.searchParams.get('ext_agent_host_id'));
  await assert.rejects(f.finish({ client_id: 'oaiapp_OTHER' }), /expected app registration/);
});

test('expired access tokens rotate once and replace credentials together', async t => {
  const f = await setup(t); await f.begin(); await f.finish(); await f.auth.selectModel('available-model');
  f.advance(3600000);
  const result = await f.auth.inferenceCredentials();
  assert.equal(result.token, 'access-1');
  assert.equal(f.refreshes(), 1);
  const record = JSON.parse(readFileSync(f.file)).accounts[0];
  assert.equal(record.refresh_token, 'refresh-1');
  assert.equal(record.refreshPending, false);
});

test('sign-out clears tokens even if remote revocation cannot be confirmed', async t => {
  const f = await setup(t); await f.begin(); await f.finish(); f.revokeFails();
  assert.deepEqual(await f.auth.signOut(), { revoked: false });
  assert.equal(f.auth.configured, false);
  const record = JSON.parse(readFileSync(f.file)).accounts[0];
  assert.equal(record.access_token, undefined);
  assert.equal(record.refresh_token, undefined);
  assert.equal(record.id_token, undefined);
  assert.equal(record.client_id, 'oaiapp_TEST');
});

function eventStream(events, chunkSize = 17) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE requires a completed response and detects limits arriving after text deltas', async () => {
  const done = { status: 'completed', output: [{ content: [{ type: 'output_text', text: '✓' }] }] };
  assert.deepEqual(await readCompletedResponse(eventStream([{ type: 'response.completed', response: done }], 1)), done);
  await assert.rejects(readCompletedResponse(eventStream([{ type: 'response.output_text.delta', delta: 'partial' }])), /before completion/);
  await assert.rejects(readCompletedResponse(eventStream([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /Manage usage/);
});

test('ChatGPT inference uses the authorized model, streaming, no storage and no unsupported output cap', async () => {
  let sent;
  const response = { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ title: 'Work', summary: 'One task.', customerNote: 'Thanks.', items: [{ name: 'Design', quantity: '1', rate: '40', source: 'Design: $40 fixed fee.' }], questions: [] }) }] }] };
  const ai = createAI({ OPENAI_API_KEY: 'must-not-use' }, async (url, options) => { sent = { ...JSON.parse(options.body), auth: options.headers.Authorization }; return eventStream([{ type: 'response.completed', response }]); }, { configured: true, model: 'available-model', inferenceCredentials: async () => ({ token: 'authorized-plan-token', model: 'available-model' }) });
  const draft = await ai.draft({ notes: 'Design: $40 fixed fee.' });
  assert.equal(ai.authMode, 'chatgpt');
  assert.equal(sent.auth, 'Bearer authorized-plan-token');
  assert.equal(sent.model, 'available-model');
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false);
  assert.equal('max_output_tokens' in sent, false);
  assert.ok(Array.isArray(sent.input));
  assert.equal(draft.items[0].rate, '40');
});

test('a plan session needing reauthorization cannot silently spend a saved API key', async () => {
  let called = false;
  const ai = createAI({ OPENAI_API_KEY: 'paid-api-key' }, async () => { called = true; throw new Error('Must not reach inference'); }, {
    prefersPlan: true, configured: false, model: 'available-model',
    inferenceCredentials: async () => { throw new Error('Reconnect your ChatGPT account'); },
  });
  assert.equal(ai.authMode, 'chatgpt');
  assert.equal(ai.configured, false);
  await assert.rejects(ai.draft({ notes: 'Design: $40 fixed fee.' }), /Reconnect/);
  assert.equal(called, false);
});

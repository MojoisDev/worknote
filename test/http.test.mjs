import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../lib/http.mjs';
import { AppError } from '../lib/domain.mjs';

async function request({ method = 'GET', url = '/', headers = {}, body = {}, callback } = {}) {
  let apiCalls = 0;
  const handler = createHttpHandler({
    port: 3000,
    app: { handle: async () => { apiCalls++; return { ok: true }; } },
    chatgpt: { callback: callback ?? (async () => {}) },
    readStatic: async file => file === 'index.html' ? '<!doctype html><h1>Worknote</h1>' : 'static content',
  });
  const req = { method, url, headers: { host: '127.0.0.1:3000', ...headers }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const result = { headers: {}, status: 0, body: '' };
  const res = {
    setHeader: (key, value) => { result.headers[key] = value; },
    writeHead: (status, values = {}) => { result.status = status; Object.assign(result.headers, values); },
    end: body => { result.body = body?.toString() ?? ''; },
  };
  await handler(req, res);
  return { ...result, apiCalls };
}

test('app document opens from an external link without weakening API restrictions', async () => {
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const page = await request({ headers });
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Worknote/);
  const api = await request({ url: '/api/config', headers });
  assert.equal(api.status, 403);
  assert.equal(api.apiCalls, 0);
});

test('OpenAI callback redirect can load the app even if navigation retains cross-site metadata', async () => {
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', origin: 'https://auth.openai.com' };
  let received;
  const callback = await request({ url: '/auth/callback?state=test&code=example', headers, callback: async params => { received = params.get('state'); } });
  assert.equal(callback.status, 303);
  assert.equal(received, 'test');
  assert.equal(callback.headers.Location, '/#settings');
  const landing = await request({ url: '/', headers });
  assert.equal(landing.status, 200);
});

test('cross-site mutation is rejected before the application receives it', async () => {
  for (const headers of [
    { origin: 'https://evil.example', 'content-type': 'application/json' },
    { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    { origin: 'null', 'content-type': 'application/json' },
  ]) {
    const result = await request({ method: 'POST', url: '/api/invoices', headers });
    assert.equal(result.status, 403);
    assert.equal(result.apiCalls, 0);
  }
});

test('same-origin localhost and loopback requests remain usable', async () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000']) {
    const result = await request({ method: 'POST', url: '/api/chatgpt/start', headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } });
    assert.equal(result.status, 200);
    assert.equal(result.apiCalls, 1);
  }
});

test('untrusted hostnames and ports are rejected on pages, APIs and callbacks', async () => {
  for (const host of ['evil.example:3000', 'localhost.evil.example:3000', '127.0.0.1:3001']) {
    for (const url of ['/', '/app.js', '/api/config', '/auth/callback?state=test']) {
      const result = await request({ url, headers: { host } });
      assert.equal(result.status, 403);
    }
  }
});

test('only known static assets are exposed; credentials are not served', async () => {
  for (const url of ['/.env.local', '/data/chatgpt-auth.json', '/../.env.local']) assert.equal((await request({ url })).status, 404);
  assert.equal((await request({ url: '/app.js', headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
});

test('callback errors retain a safe link back to the app and escape HTML', async () => {
  const result = await request({ url: '/auth/callback?state=bad', headers: { 'sec-fetch-site': 'cross-site' }, callback: async () => { throw new AppError('<script>bad()</script>'); } });
  assert.equal(result.status, 400);
  assert.ok(result.body.includes('&lt;script&gt;'));
  assert.ok(!result.body.includes('<script>'));
  assert.ok(result.body.includes('href="/#settings"'));
});

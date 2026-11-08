import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, applyRemote, lineCents, paypalPayload, sandboxUrl, validateInvoice } from '../lib/domain.mjs';
import { openStore } from '../lib/store.mjs';
import { createApplication } from '../lib/application.mjs';
import { createPaypal } from '../lib/paypal.mjs';
import { createAI } from '../lib/ai.mjs';

const input = () => ({ title: 'Website launch', clientName: 'Test studio', clientEmail: 'buyer@personal.example.com', notes: 'Homepage: 4 hours at $60 per hour.', customerNote: 'Thank you.', term: 'NET_15', items: [{ name: 'Homepage', quantity: '4', rate: '60.00', source: 'Homepage: 4 hours at $60 per hour.' }] });
function fixture(t, overrides = {}) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  let state = 'DRAFT';
  let creations = 0;
  let activations = 0;
  const paypal = {
    configured: true,
    authenticate: async () => 'token',
    create: async payload => { creations++; assert.equal(payload.detail.currency_code, 'USD'); return { id: 'INV2-TEST-TEST-TEST-TEST' }; },
    get: async id => ({ id, status: state, amount: { currency_code: 'USD', value: '240.00' }, detail: { metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/test' } } }),
    activate: async () => { activations++; state = 'SENT'; },
    ...overrides,
  };
  const app = createApplication({ store, paypal, ai: { configured: false, model: 'test' } });
  return { store, app, paypal, creations: () => creations, activations: () => activations, markPaid: () => { state = 'PAID'; } };
}

test('money uses integer cents and rounds each fractional-hour line', () => {
  assert.equal(lineCents({ quantity: '0.33', rate: '10.01' }), 330);
  assert.equal(lineCents({ quantity: '0.5', rate: '0.01' }), 1);
  const invoice = validateInvoice({ ...input(), items: [{ name: 'A', quantity: '4', rate: '60' }, { name: 'B', quantity: '2', rate: '45' }, { name: 'C', quantity: '1', rate: '50' }] });
  assert.equal(invoice.totalCents, 38000);
});

test('reject missing prices, negative amounts, excess precision, and malformed customer email', () => {
  for (const rate of ['', '-1', '0', '1e3', '1.001', 'Infinity']) {
    assert.throws(() => validateInvoice({ ...input(), items: [{ name: 'Work', quantity: '1', rate }] }));
  }
  assert.throws(() => validateInvoice({ ...input(), clientEmail: 'not an email' }));
  assert.throws(() => validateInvoice({ ...input(), items: [] }));
});

test('PayPal payload keeps source notes internal and uses approved prices only', () => {
  const payload = paypalPayload({ ...validateInvoice(input()), number: 'WN-TEST' });
  assert.deepEqual(payload.primary_recipients, [{ billing_info: { email_address: input().clientEmail } }]);
  assert.equal(payload.items[0].unit_amount.value, '60.00');
  assert.equal(JSON.stringify(payload).includes('source'), false);
  assert.equal(payload.detail.payment_term.term_type, 'NET_15');
});

test('payment URLs cannot switch to live PayPal or an attacker domain', () => {
  assert.equal(sandboxUrl('https://www.paypal.com/invoice/p/abc'), null);
  assert.equal(sandboxUrl('https://www.sandbox.paypal.com.evil.test/'), null);
  assert.equal(sandboxUrl('javascript:alert(1)'), null);
  assert.ok(sandboxUrl('https://www.sandbox.paypal.com/invoice/p/abc'));
});

test('complete review, create, activate and confirmed payment flow', async t => {
  const f = fixture(t);
  let invoice = await f.app.handle('POST', '/api/invoices', input());
  assert.equal(invoice.status, 'LOCAL_DRAFT');
  const path = `/api/invoices/${invoice.id}`;
  await assert.rejects(f.app.handle('POST', `${path}/create-paypal`, { version: invoice.version }), /approve/i);
  invoice = await f.app.handle('POST', `${path}/create-paypal`, { version: invoice.version, approved: true });
  assert.equal(invoice.status, 'DRAFT');
  assert.equal(f.creations(), 1);
  await assert.rejects(f.app.handle('PUT', path, { ...input(), version: invoice.version }), /locked/i);
  invoice = await f.app.handle('POST', `${path}/activate`, { approved: true });
  assert.equal(invoice.status, 'SENT');
  assert.equal(f.activations(), 1);
  await f.app.handle('POST', `${path}/activate`, { approved: true });
  assert.equal(f.activations(), 1, 'activating an already payable invoice must not call send again');
  f.markPaid();
  invoice = await f.app.handle('POST', `${path}/refresh`);
  assert.equal(invoice.status, 'PAID');
  assert.ok(invoice.checkedAt);
  assert.equal(invoice.totalCents, 24000);
});

test('stale draft updates cannot overwrite a newer edit', async t => {
  const f = fixture(t);
  const invoice = await f.app.handle('POST', '/api/invoices', input());
  const path = `/api/invoices/${invoice.id}`;
  const updated = await f.app.handle('PUT', path, { ...input(), title: 'Revised', version: invoice.version });
  await assert.rejects(f.app.handle('PUT', path, { ...input(), version: invoice.version }), /another tab/);
  assert.equal(f.store.get(invoice.id).title, 'Revised');
  assert.equal(updated.version, 2);
});

test('ambiguous creation is retained and cannot create a duplicate on retry', async t => {
  let count = 0;
  const f = fixture(t, { create: async () => { count++; throw new AppError('Timeout', 502, true); } });
  let invoice = await f.app.handle('POST', '/api/invoices', input());
  const path = `/api/invoices/${invoice.id}`;
  await assert.rejects(f.app.handle('POST', `${path}/create-paypal`, { approved: true, version: invoice.version }), /Timeout/);
  invoice = f.store.get(invoice.id);
  assert.equal(invoice.status, 'CREATION_UNCERTAIN');
  await assert.rejects(f.app.handle('POST', `${path}/create-paypal`, { approved: true, version: invoice.version }), /uncertain/);
  assert.equal(count, 1);
});

test('failed retrieval after creation preserves PayPal ID and never repeats create', async t => {
  const f = fixture(t, { get: async () => { throw new AppError('Unavailable', 502); } });
  let invoice = await f.app.handle('POST', '/api/invoices', input());
  const path = `/api/invoices/${invoice.id}`;
  await assert.rejects(f.app.handle('POST', `${path}/create-paypal`, { approved: true, version: invoice.version }));
  invoice = f.store.get(invoice.id);
  assert.equal(invoice.paypalId, 'INV2-TEST-TEST-TEST-TEST');
  assert.equal(invoice.status, 'DRAFT');
  await f.app.handle('POST', `${path}/create-paypal`, { approved: true, version: invoice.version });
  assert.equal(f.creations(), 1);
});

test('failed refresh preserves the last confirmed payment state', async t => {
  const f = fixture(t);
  let invoice = await f.app.handle('POST', '/api/invoices', input());
  const path = `/api/invoices/${invoice.id}`;
  invoice = await f.app.handle('POST', `${path}/create-paypal`, { approved: true, version: invoice.version });
  f.markPaid();
  invoice = await f.app.handle('POST', `${path}/refresh`);
  f.paypal.get = async () => { throw new AppError('Offline', 502); };
  await assert.rejects(f.app.handle('POST', `${path}/refresh`));
  assert.equal(f.store.get(invoice.id).status, 'PAID');
  assert.equal(f.store.get(invoice.id).checkedAt, invoice.checkedAt);
});

test('concurrent creation requests perform only one upstream create', async t => {
  let unblock;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const f = fixture(t, { create: async () => { entered(); await gate; return { id: 'INV2-TEST-TEST-TEST-TEST' }; } });
  const invoice = await f.app.handle('POST', '/api/invoices', input());
  const path = `/api/invoices/${invoice.id}/create-paypal`;
  const first = f.app.handle('POST', path, { approved: true, version: invoice.version });
  await started;
  await assert.rejects(f.app.handle('POST', path, { approved: true, version: invoice.version }), /already being updated/);
  unblock();
  await first;
});

test('PayPal wrapper uses only sandbox and disables both notification flags', async () => {
  const calls = [];
  const paypal = createPaypal({ PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENVIRONMENT: 'sandbox' }, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/token')) return Response.json({ access_token: 'TEST_TOKEN', expires_in: 3600 });
    return new Response(null, { status: 202 });
  });
  await paypal.activate('INV2-TEST');
  await paypal.activate('INV2-TEST');
  assert.ok(calls.every(call => new URL(call.url).hostname === 'api-m.sandbox.paypal.com'));
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.deepEqual(JSON.parse(calls[1].options.body), { send_to_invoicer: false, send_to_recipient: false });
  const live = createPaypal({ PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENVIRONMENT: 'live' });
  await assert.rejects(live.authenticate(), /only supports PayPal sandbox/);
});

test('AI missing key has an explicit error and never silently produces sample output', async () => {
  const ai = createAI({});
  assert.equal(ai.configured, false);
  await assert.rejects(ai.draft({ notes: input().notes }), /OPENAI_API_KEY/);
});

test('AI schema extraction keeps missing rates blank and strips unsupported evidence', async () => {
  let sent;
  const ai = createAI({ OPENAI_API_KEY: 'test-key' }, async (url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ title: 'Launch', summary: 'Two tasks.', customerNote: 'Thank you.', items: [{ name: 'Homepage', quantity: '4', rate: null, source: input().notes }, { name: 'Invented', quantity: '9', rate: '100', source: 'This text never appeared.' }], questions: ['What was the agreed rate?'] }) }] }] });
  });
  const result = await ai.draft({ notes: input().notes });
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.equal(result.items[0].rate, '');
  assert.equal(result.items[1].quantity, '');
  assert.equal(result.items[1].rate, '');
  assert.equal(result.items[1].source, '');
  assert.equal(result.questions.length, 2);
});

test('refusal and incomplete model output are surfaced, not saved as invoices', async () => {
  for (const data of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }]) {
    const ai = createAI({ OPENAI_API_KEY: 'test' }, async () => Response.json(data));
    await assert.rejects(ai.draft({ notes: input().notes }));
  }
});

test('remote non-USD invoices cannot contaminate USD totals', () => {
  assert.throws(() => applyRemote({ totalCents: 100 }, { amount: { currency_code: 'EUR', value: '1.00' } }), /Only USD/);
});

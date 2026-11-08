import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lineCents } from '../lib/domain.mjs';

// Exercise the actual browser module with a minimal DOM boundary. Layout still needs browser QA.
async function editor(initial = {}) {
  const elements = new Map();
  const data = new Map(Object.entries(initial));
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', hidden: false, classList: { remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {} });
    return elements.get(selector);
  };
  const document = { querySelector: get, querySelectorAll: () => [], addEventListener() {} };
  const localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const fetcher = async url => Response.json(url === '/api/config' ? { aiConfigured: false, paypalConfigured: true } : { invoices: [] });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const hooks = await new AsyncFunction('document', 'window', 'location', 'localStorage', 'fetch', `${source}\nreturn { lineTotal, renderDetail, renderList, getDraft: () => draft };`)(document, { addEventListener() {} }, { hash: '#new' }, localStorage, fetcher);
  return { ...hooks, elements, data };
}

test('editor totals match the server for fractional rates and quantities', async () => {
  const ui = await editor();
  for (const [quantity, rate] of [['0.5', '0.01'], ['0.33', '10.01'], ['4', '60.00'], ['1.25', '84.99']]) {
    assert.equal(ui.lineTotal({ quantity, rate }), lineCents({ quantity, rate }));
  }
  assert.equal(ui.lineTotal({ quantity: '1', rate: '' }), null);
});

test('first-run editor is honest about missing AI configuration and zero total', async () => {
  const ui = await editor();
  const html = ui.elements.get('#view').innerHTML;
  assert.match(html, /New invoice/);
  assert.match(html, /AI needs a connection/);
  assert.match(html, /Continue with ChatGPT or add an API key/);
  assert.match(html, /data-action="ai" disabled/);
  assert.equal(ui.elements.get('#invoice-total').textContent, '$0.00');
});

test('customer-controlled titles and notes are escaped in invoice details', async () => {
  const ui = await editor();
  ui.renderDetail({ id: 'test', title: '<img src=x onerror=alert(1)>', number: 'WN-TEST', clientName: '<script>bad()</script>', clientEmail: 'test@example.com', notes: '<script>bad()</script>', items: [{ name: '<svg onload=alert(1)>', quantity: '1', rate: '10.00', source: '<iframe>' }], term: 'NET_15', totalCents: 1000, createdAt: new Date().toISOString(), status: 'LOCAL_DRAFT' });
  const html = ui.elements.get('#view').innerHTML;
  assert.equal(html.includes('<script>bad()'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;iframe&gt;'));
});

test('empty ledger displays real zeros and a useful first action', async () => {
  const ui = await editor();
  ui.renderList();
  assert.match(ui.elements.get('#view').innerHTML, /\$0\.00/);
  assert.match(ui.elements.get('#invoice-list').innerHTML, /Your first invoice starts here/);
  assert.match(ui.elements.get('#invoice-list').innerHTML, /Import your earlier sandbox test/);
});

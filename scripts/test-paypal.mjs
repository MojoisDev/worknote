import { readFile, writeFile } from 'node:fs/promises';

const base = 'https://api-m.sandbox.paypal.com';
const stateFile = new URL('../.sandbox-test.json', import.meta.url);
const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();

async function main() {
  if (process.env.PAYPAL_ENVIRONMENT !== 'sandbox') {
    throw new Error('PAYPAL_ENVIRONMENT must be sandbox.');
  }
  if (!clientId || !clientSecret) {
    throw new Error('Add both sandbox credentials to .env.local first.');
  }

  const auth = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const token = await auth.json();
  if (!auth.ok || !token.access_token) {
    throw new Error(`Authentication failed (HTTP ${auth.status}). Check that the credentials belong to a sandbox app.`);
  }
  console.log('PASS: PayPal sandbox credentials authenticated.');

  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      const issues = data.details?.map(d => `${d.field ?? ''}: ${d.issue}`).join('; ');
      throw new Error(`PayPal HTTP ${response.status}: ${data.name ?? 'API_ERROR'}${issues ? ` (${issues})` : ''}`);
    }
    return data;
  }

  let saved;
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  let invoiceId = saved?.invoiceId;
  if (!invoiceId) {
    const draft = await request('/v2/invoicing/invoices', {
      method: 'POST',
      body: JSON.stringify({
        detail: {
          currency_code: 'USD',
          note: 'Sandbox integration test only. No real payment requested.',
          payment_term: { term_type: 'DUE_ON_RECEIPT' },
        },
        items: [{
          name: 'Freelance design - sandbox test',
          quantity: '1',
          unit_amount: { currency_code: 'USD', value: '10.00' },
        }],
      }),
    });
    invoiceId = draft.id;
    if (!invoiceId) {
      const href = draft.href ?? draft.links?.find(link => link.rel === 'self')?.href;
      invoiceId = href?.split('/').pop();
    }
    if (!invoiceId?.startsWith('INV2-')) throw new Error('Draft response did not contain an invoice ID.');
    await writeFile(stateFile, JSON.stringify({ invoiceId }, null, 2) + '\n', { mode: 0o600 });
    console.log('PASS: Created a sandbox draft invoice.');
  } else {
    console.log('Reusing the previous test invoice.');
  }

  const path = `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`;
  let invoice = await request(path);
  if (process.argv.includes('--make-payable') && invoice.status === 'DRAFT') {
    await request(`${path}/send`, {
      method: 'POST',
      body: JSON.stringify({ send_to_invoicer: false, send_to_recipient: false }),
    });
    console.log('PASS: Activated sandbox invoice with email notifications disabled.');
    invoice = await request(path);
  }
  console.log(`PASS: Retrieved invoice ${invoice.id}.`);
  console.log(`Status: ${invoice.status}`);
  console.log(`Amount: ${invoice.amount?.currency_code ?? 'USD'} ${invoice.amount?.value ?? '10.00'}`);
  const paymentUrl = invoice.detail?.metadata?.recipient_view_url;
  if (paymentUrl) {
    const url = new URL(paymentUrl);
    if (url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com') {
      console.log(`Sandbox payment link: ${url.href}`);
    } else {
      console.log('Payment link withheld: expected www.sandbox.paypal.com.');
    }
  }
  console.log('This script does not make payments.');
}

main().catch(error => {
  console.error(`Test failed: ${error.cause?.code ?? error.message}`);
  process.exitCode = 1;
});

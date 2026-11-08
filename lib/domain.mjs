export class AppError extends Error {
  constructor(message, status = 400, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}

export function text(value, max = 250, label = 'Value') {
  if (typeof value !== 'string' || value.length > max) throw new AppError(`${label} is invalid or too long.`);
  return value.trim();
}

// Prices stay as decimal strings. All arithmetic uses integers, including fractional hours.
export function decimal(value, places, label) {
  const s = String(value ?? '').trim();
  if (!new RegExp(`^\\d{1,7}(?:\\.\\d{1,${places}})?$`).test(s)) {
    throw new AppError(`${label} must be a positive number with up to ${places} decimal places.`);
  }
  const [whole, fraction = ''] = s.split('.');
  const units = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0'));
  if (units <= 0) throw new AppError(`${label} must be greater than zero.`);
  return units;
}

export function lineCents(item) {
  const quantity = decimal(item.quantity, 2, 'Quantity');
  const cents = decimal(item.rate, 2, 'Rate');
  const product = quantity * cents;
  if (!Number.isSafeInteger(product)) throw new AppError('Line amount is too large.');
  return Math.floor((product + 50) / 100);
}

export function validateInvoice(body) {
  if (!body || typeof body !== 'object') throw new AppError('An invoice is required.');
  const title = text(body.title, 120, 'Project name');
  const clientName = text(body.clientName, 150, 'Client name');
  const clientEmail = text(body.clientEmail, 254, 'Client email');
  if (!title || !clientName) throw new AppError('Add the project and client names.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new AppError('Add a valid sandbox customer email.');
  const notes = text(body.notes ?? '', 12000, 'Work notes');
  const customerNote = text(body.customerNote ?? '', 1000, 'Customer note');
  const term = body.term ?? 'DUE_ON_RECEIPT';
  if (!['DUE_ON_RECEIPT', 'NET_15', 'NET_30'].includes(term)) throw new AppError('Choose a supported payment term.');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 25) {
    throw new AppError('Add between 1 and 25 invoice items.');
  }
  const items = body.items.map(item => {
    const name = text(item.name, 180, 'Item description');
    if (!name) throw new AppError('Every item needs a description.');
    const quantity = String(item.quantity ?? '').trim();
    const rate = String(item.rate ?? '').trim();
    const source = text(item.source ?? '', 1000, 'Source note');
    const result = { name, quantity, rate, source };
    lineCents(result);
    return result;
  });
  const totalCents = items.reduce((sum, item) => sum + lineCents(item), 0);
  if (totalCents > 100000000) throw new AppError('This prototype supports invoices up to USD 1,000,000.00.');
  return { title, clientName, clientEmail, notes, customerNote, term, items, currency: 'USD', totalCents };
}

export function paypalPayload(invoice) {
  return {
    detail: {
      invoice_number: invoice.number,
      currency_code: 'USD',
      reference: invoice.title,
      note: invoice.customerNote || 'Thank you for your business.',
      payment_term: { term_type: invoice.term },
    },
    primary_recipients: [{ billing_info: { email_address: invoice.clientEmail } }],
    items: invoice.items.map(item => ({
      name: item.name,
      quantity: item.quantity,
      unit_amount: { currency_code: 'USD', value: (decimal(item.rate, 2, 'Rate') / 100).toFixed(2) },
    })),
  };
}

export function sandboxUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com' ? url.href : null;
  } catch { return null; }
}

export function applyRemote(invoice, remote) {
  const currency = remote.amount?.currency_code ?? remote.detail?.currency_code;
  if (currency && currency !== 'USD') throw new AppError('Only USD invoices are supported in this version.');
  const rawAmount = remote.amount?.value;
  let remoteCents = invoice.totalCents;
  if (rawAmount != null) {
    remoteCents = Math.round(Number(rawAmount) * 100);
    if (!Number.isSafeInteger(remoteCents) || remoteCents < 0) throw new AppError('PayPal returned an invalid invoice amount.', 502);
  }
  return {
    ...invoice,
    paypalId: remote.id,
    status: remote.status,
    totalCents: remoteCents,
    paymentUrl: sandboxUrl(remote.detail?.metadata?.recipient_view_url),
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

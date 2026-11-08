import { AppError } from './domain.mjs';

export function createPaypal(env, fetcher = fetch) {
  const base = 'https://api-m.sandbox.paypal.com';
  let token;
  let tokenUntil = 0;
  let tokenRequest;
  const configured = Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim());
  async function authenticate() {
    if (!configured) throw new AppError('Add PayPal sandbox credentials to .env.local and restart the app.', 503);
    if (env.PAYPAL_ENVIRONMENT !== 'sandbox') throw new AppError('This application only supports PayPal sandbox.', 503);
    if (token && Date.now() < tokenUntil) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      let response;
      try {
        response = await fetcher(`${base}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID.trim()}:${env.PAYPAL_CLIENT_SECRET.trim()}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(20000),
        });
      } catch { throw new AppError('Could not reach PayPal. Check your internet connection and retry.', 502); }
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new AppError('PayPal authentication failed. Check the sandbox client ID and secret.', 502);
      token = data.access_token;
      tokenUntil = Date.now() + Math.max(0, (Number(data.expires_in) || 300) - 60) * 1000;
      return token;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }
  async function request(path, options = {}) {
    const access = await authenticate();
    let response;
    try {
      response = await fetcher(`${base}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AppError('PayPal did not return a result. Check the invoice in your sandbox dashboard before retrying.', 502, options.method === 'POST');
    }
    let data;
    try { const raw = await response.text(); data = raw ? JSON.parse(raw) : {}; }
    catch { throw new AppError('PayPal returned an unreadable response. Check the sandbox dashboard.', 502, options.method === 'POST'); }
    if (!response.ok) {
      if (response.status === 401) { token = null; tokenUntil = 0; }
      const issues = data.details?.map(detail => detail.issue).filter(value => typeof value === 'string').join(', ');
      throw new AppError(`PayPal rejected the request (${response.status}${issues ? `: ${issues}` : ''}).`, 502, response.status >= 500 && options.method === 'POST');
    }
    return data;
  }
  const path = id => `/v2/invoicing/invoices/${encodeURIComponent(id)}`;
  return {
    configured,
    authenticate,
    get: id => request(path(id)),
    async create(payload) {
      const result = await request('/v2/invoicing/invoices', { method: 'POST', body: JSON.stringify(payload) });
      const href = result.href ?? result.links?.find(link => link.rel === 'self')?.href;
      const id = result.id ?? href?.split('/').pop();
      if (!/^INV2-[A-Z0-9-]+$/.test(id ?? '')) throw new AppError('PayPal created a draft but did not return its ID. Check the sandbox dashboard.', 502, true);
      return { id };
    },
    activate: id => request(`${path(id)}/send`, {
      method: 'POST', body: JSON.stringify({ send_to_invoicer: false, send_to_recipient: false }),
    }),
  };
}

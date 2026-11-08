import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './domain.mjs';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const authEndpoint = `${issuer}/api/accounts/authorize`;
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function verifyIdentity(token, jwks, { clientId, nonce, subject, now = Date.now() }) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 30000) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Fail closed on unimplemented algorithms; never accept symmetric or unsigned identity tokens.
    if (header.alg !== 'RS256' || header.crit || typeof header.kid !== 'string') throw new Error();
    const matches = jwks.keys?.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (matches?.length !== 1) throw new Error();
    const key = createPublicKey({ key: matches[0], format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error();
    const seconds = now / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)) throw new Error();
    if (typeof claims.exp !== 'number' || claims.exp <= seconds - 5 || typeof claims.iat !== 'number' || claims.iat > seconds + 5) throw new Error();
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > seconds + 5)) throw new Error();
    if (typeof claims.sub !== 'string' || !claims.sub || (subject && claims.sub !== subject) || (nonce !== undefined && !equal(claims.nonce, nonce))) throw new Error();
    return claims;
  } catch { throw new AppError('ChatGPT identity verification failed. Start a new sign-in; no credentials were accepted.', 401); }
}

export function createChatGPT({ file, port, fetcher = fetch, now = () => Date.now() }) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the protected ChatGPT account file.'); }
  state ??= { hostId: `urn:uuid:${randomUUID()}`, accounts: [], active: null };
  if (!Array.isArray(state.accounts) || typeof state.hostId !== 'string') throw new Error('The protected ChatGPT account file is invalid.');
  const pending = new Map();
  const modelCache = new Map();
  let discoveryCache;
  let operation = false;
  const callbackUri = `http://127.0.0.1:${port}/auth/callback`;

  function persist() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, file); }
    finally { try { unlinkSync(temp); } catch {} }
  }
  async function locked(fn) {
    if (operation) throw new AppError('Another ChatGPT connection operation is in progress. Please wait.', 409);
    operation = true;
    let fd;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try { fd = openSync(`${file}.lock`, 'wx', 0o600); }
      catch { throw new AppError('The ChatGPT connection is locked by another process. Close other Worknote servers and retry.', 409); }
      // Reload while holding the lock so rotating refresh tokens are not reused by another process.
      try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return await fn();
    } finally { if (fd !== undefined) { closeSync(fd); unlinkSync(`${file}.lock`); } operation = false; }
  }
  function activeAccount() { return state.accounts.find(account => account.id === state.active); }
  function publicAccount(account) {
    return { id: account.id, label: account.label, email: account.email, connected: Boolean(account.access_token && !account.needsSignIn), planEnabled: account.scopes?.includes('chatgpt.tokens.use.direct') ?? false, model: account.model ?? '', welcomed: Boolean(account.welcomed) };
  }
  async function network(url, options = {}) {
    try { return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new AppError('Could not reach OpenAI. Check the internet connection and try again.', 502); }
  }
  async function discovery() {
    if (discoveryCache) return discoveryCache;
    const response = await network(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new AppError('Could not load OpenAI sign-in configuration.', 502);
    const data = await response.json();
    if (data.issuer !== issuer) throw new AppError('Unexpected OpenAI sign-in issuer.', 502);
    for (const key of ['jwks_uri', 'revocation_endpoint']) {
      const url = new URL(data[key]);
      if (url.origin !== issuer) throw new AppError('Unexpected OpenAI sign-in endpoint.', 502);
    }
    discoveryCache = data;
    return data;
  }
  async function identity(idToken, expected) {
    const config = await discovery();
    const response = await network(config.jwks_uri);
    if (!response.ok) throw new AppError('Could not verify OpenAI signing keys.', 502);
    return verifyIdentity(idToken, await response.json(), { ...expected, now: now() });
  }
  function tokenFields(data, previous) {
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new AppError('OpenAI returned an invalid token response. Sign in again.', 502);
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    return { access_token: data.access_token, refresh_token: data.refresh_token || previous?.refresh_token || null, id_token: data.id_token || previous?.id_token || null, expiresAt: now() + data.expires_in * 1000, scopes, needsSignIn: false, refreshPending: false };
  }
  async function access() {
    return locked(async () => {
      const account = activeAccount();
      if (!account?.access_token || account.needsSignIn || account.refreshPending) throw new AppError('Continue with ChatGPT in Connections to authorize plan usage.', 401);
      if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw new AppError('ChatGPT plan use was not authorized. Sign in again and review the requested permission.', 403);
      if (account.expiresAt > now() + 60000) return { token: account.access_token, accountId: account.id };
      if (!account.refresh_token) throw new AppError('Your ChatGPT session expired. Sign in again in Connections.', 401);
      account.refreshPending = true; persist();
      try {
        const response = await network(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource }) });
        if (!response.ok) throw new AppError('Your ChatGPT session needs a new sign-in. Open Connections.', 401);
        const data = await response.json();
        if (data.id_token) await identity(data.id_token, { clientId: account.client_id, subject: account.subject });
        Object.assign(account, tokenFields(data, account));
        if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new AppError('ChatGPT plan permission is no longer enabled. Sign in again.', 403);
        persist();
        return { token: account.access_token, accountId: account.id };
      } catch (error) {
        // An interrupted refresh may have rotated the token. Require fresh authorization rather than replaying it.
        account.needsSignIn = true; account.refreshPending = false; persist();
        throw error;
      }
    });
  }
  async function models() {
    const auth = await access();
    const cached = modelCache.get(auth.accountId);
    if (cached && cached.until > now()) return cached.models;
    const response = await network(`${resource}/models`, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!response.ok) throw new AppError('Could not load models for your ChatGPT account. Reconnect if access was revoked.', response.status === 401 ? 401 : 502);
    const data = await response.json();
    if (!Array.isArray(data.models)) throw new AppError('OpenAI returned an unexpected model catalog.', 502);
    const available = data.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string').map(model => ({ id: model.slug, name: model.display_name }));
    modelCache.set(auth.accountId, { models: available, until: now() + 60000 });
    return available;
  }
  return {
    status() { const account = activeAccount(); return { accounts: state.accounts.map(publicAccount), active: account ? publicAccount(account) : null }; },
    get prefersPlan() { return state.usePlan === true; },
    get configured() { const account = activeAccount(); return Boolean(account?.access_token && !account.needsSignIn && !account.refreshPending && account.scopes?.includes('chatgpt.tokens.use.direct')); },
    get model() { return activeAccount()?.model ?? ''; },
    async begin(accountId) {
      return locked(async () => {
        for (const [key, attempt] of pending) if (attempt.expiresAt < now()) pending.delete(key);
        if (pending.size >= 8) throw new AppError('Several sign-ins are already pending. Wait a few minutes and retry.', 429);
        const account = accountId ? state.accounts.find(value => value.id === accountId) : null;
        if (accountId && !account) throw new AppError('ChatGPT account not found.', 404);
        persist();
        const verifier = random();
        const attempt = { state: random(), nonce: random(), verifier, accountId: account?.id, clientId: account?.client_id, expiresAt: now() + 600000 };
        pending.set(attempt.state, attempt);
        const url = new URL(authEndpoint);
        const params = { client_id: account?.client_id || 'dynamic_agent_client', ext_agent_host_id: state.hostId, response_type: 'code', redirect_uri: callbackUri, scope, resource, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
        if (!account) params.agent_name_hint = 'Worknote';
        // No retained ID-token hint is sent to the browser; returning users can choose their account.
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return { authorizationUrl: url.href };
      });
    },
    async callback(params) {
      const attempt = pending.get(params.get('state'));
      if (!attempt || attempt.expiresAt < now()) throw new AppError('This sign-in is missing, expired, or already used. Return to Connections and start again.', 400);
      pending.delete(attempt.state);
      return locked(async () => {
        if (params.has('error')) throw new AppError('ChatGPT sign-in was declined or could not finish. Return to Connections to retry.', 400);
        const clientId = params.get('client_id') || attempt.clientId;
        if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && clientId !== attempt.clientId)) throw new AppError('OpenAI did not return the expected app registration. Please retry sign-in.', 400);
        const code = params.get('code');
        if (!code || code.length > 10000) throw new AppError('The sign-in callback did not contain a valid authorization code.', 400);
        const response = await network(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: callbackUri, resource }) });
        if (!response.ok) throw new AppError('OpenAI could not complete sign-in. Return to Connections and start again.', 401);
        const data = await response.json();
        const previous = attempt.accountId ? state.accounts.find(account => account.id === attempt.accountId) : null;
        const claims = await identity(data.id_token, { clientId, nonce: attempt.nonce, subject: previous?.subject });
        const credentials = tokenFields(data);
        if (!credentials.scopes.includes('openid')) throw new AppError('OpenAI did not grant identity permission.', 403);
        const existing = previous || state.accounts.find(account => account.client_id === clientId && account.subject === claims.sub);
        const account = {
          ...existing, id: existing?.id || randomUUID(), client_id: clientId, issuer, subject: claims.sub,
          email: typeof claims.email === 'string' ? claims.email.slice(0, 254) : '',
          label: existing?.label || `${typeof claims.email === 'string' ? claims.email.slice(0, 254) : 'ChatGPT account'} · ${randomBytes(2).toString('hex')}`,
          ...credentials,
        };
        state.accounts = [...state.accounts.filter(value => value.id !== account.id), account];
        state.active = account.id; state.usePlan = true; persist();
        return { planEnabled: account.scopes.includes('chatgpt.tokens.use.direct') };
      });
    },
    async select(accountId) { return locked(async () => { if (!state.accounts.some(account => account.id === accountId)) throw new AppError('ChatGPT account not found.', 404); state.active = accountId; state.usePlan = true; persist(); return this.status(); }); },
    models,
    async selectModel(model) {
      const accountId = activeAccount()?.id;
      const available = await models();
      if (!available.some(value => value.id === model)) throw new AppError('Choose a model available to the active ChatGPT account.');
      return locked(async () => { if (state.active !== accountId) throw new AppError('The ChatGPT account changed. Reload the model list.', 409); activeAccount().model = model; persist(); return { model }; });
    },
    async welcome() { return locked(async () => { const account = activeAccount(); if (account) { account.welcomed = true; persist(); } return { ok: true }; }); },
    async signOut() {
      return locked(async () => {
        const account = activeAccount();
        if (!account) return { revoked: true };
        let revoked = !account.refresh_token;
        if (account.refresh_token) {
          try {
            const config = await discovery();
            const response = await network(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }) });
            revoked = response.status === 200;
          } catch { revoked = false; }
        }
        for (const key of ['access_token', 'refresh_token', 'id_token', 'expiresAt', 'scopes', 'refreshPending']) delete account[key];
        account.needsSignIn = true; state.usePlan = false; modelCache.delete(account.id); persist();
        return { revoked };
      });
    },
    async inferenceCredentials() {
      const auth = await access();
      const account = activeAccount();
      if (account.id !== auth.accountId) throw new AppError('The ChatGPT account changed. Please retry.', 409);
      if (!account.model) throw new AppError('Choose a ChatGPT model in Connections before drafting.');
      const available = await models();
      if (!available.some(model => model.id === account.model)) throw new AppError('Your selected model is no longer available. Choose another in Connections.');
      if (state.active !== auth.accountId) throw new AppError('The ChatGPT account changed. Please retry.', 409);
      return { token: auth.token, model: account.model };
    },
  };
}

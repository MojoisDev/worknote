import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, applyRemote, paypalPayload, validateInvoice } from './domain.mjs';

export function createApplication({ store, paypal, ai, testStateFile, chatgpt = null }) {
  const locks = new Set();
  async function exclusive(id, fn) {
    if (locks.has(id)) throw new AppError('This invoice is already being updated. Please wait.', 409);
    locks.add(id);
    try { return await fn(); } finally { locks.delete(id); }
  }
  function get(id) {
    const invoice = store.get(id);
    if (!invoice) throw new AppError('Invoice not found.', 404);
    return invoice;
  }
  function save(invoice) {
    const result = store.update({ ...invoice, updatedAt: new Date().toISOString() }, invoice.version);
    if (!result) throw new AppError('This invoice changed in another tab. Reload before trying again.', 409);
    return result;
  }
  function remoteValid(remote, id) {
    if (!remote || remote.id !== id || typeof remote.status !== 'string') throw new AppError('PayPal returned an unexpected invoice.', 502);
    return remote;
  }
  return {
    async handle(method, path, body = {}) {
      if (method === 'GET' && path === '/api/config') {
        return { environment: 'sandbox', paypalConfigured: paypal.configured, aiConfigured: ai.configured, model: ai.model, authMode: ai.authMode ?? 'none', chatgpt: chatgpt?.status() ?? { accounts: [], active: null } };
      }
      if (chatgpt && path.startsWith('/api/chatgpt/')) {
        if (method === 'POST' && path === '/api/chatgpt/start') return chatgpt.begin(body.accountId);
        if (method === 'POST' && path === '/api/chatgpt/select-account') return chatgpt.select(body.accountId);
        if (method === 'GET' && path === '/api/chatgpt/models') return { models: await chatgpt.models() };
        if (method === 'POST' && path === '/api/chatgpt/model') return chatgpt.selectModel(body.model);
        if (method === 'POST' && path === '/api/chatgpt/sign-out') return chatgpt.signOut();
        if (method === 'POST' && path === '/api/chatgpt/welcome') return chatgpt.welcome();
      }
      if (method === 'GET' && path === '/api/invoices') return { invoices: store.list() };
      if (method === 'POST' && path === '/api/ai/draft') return ai.draft(body);
      if (method === 'POST' && path === '/api/paypal/test') { await paypal.authenticate(); return { connected: true }; }
      if (method === 'POST' && path === '/api/import-test') {
        if (!testStateFile) throw new AppError('No earlier test invoice is available.', 404);
        let state;
        try { state = JSON.parse(await readFile(testStateFile, 'utf8')); }
        catch { throw new AppError('No earlier sandbox test invoice was found.', 404); }
        const id = state.invoiceId;
        if (!/^INV2-[A-Z0-9-]+$/.test(id ?? '')) throw new AppError('The saved test invoice ID is invalid.');
        return exclusive(id, async () => {
          const existing = store.list().find(invoice => invoice.paypalId === id);
          if (existing) return existing;
          const remote = remoteValid(await paypal.get(id), id);
          const now = new Date().toISOString();
          const imported = applyRemote({
            id: randomUUID(), title: 'First sandbox invoice', clientName: 'Sandbox test customer', clientEmail: '',
            number: remote.detail?.invoice_number ?? 'Sandbox test', notes: '', customerNote: '',
            term: 'DUE_ON_RECEIPT', currency: 'USD', totalCents: 0,
            items: (remote.items ?? []).map(item => ({ name: item.name, quantity: item.quantity, rate: item.unit_amount?.value ?? '', source: '' })),
            createdAt: now, updatedAt: now, imported: true,
          }, remote);
          return store.insert(imported);
        });
      }
      if (method === 'POST' && path === '/api/invoices') {
        const data = validateInvoice(body);
        const now = new Date().toISOString();
        const id = randomUUID();
        return store.insert({ ...data, id, number: `WN-${id.replaceAll('-', '').slice(0, 16).toUpperCase()}`, status: 'LOCAL_DRAFT', paypalId: null, paymentUrl: null, createdAt: now, updatedAt: now, checkedAt: null });
      }
      const match = path.match(/^\/api\/invoices\/([a-f0-9-]+)(?:\/(create-paypal|activate|refresh))?$/);
      if (!match) throw new AppError('Not found.', 404);
      const [, id, action] = match;
      if (method === 'GET' && !action) return get(id);
      if (method === 'PUT' && !action) return exclusive(id, async () => {
        const current = get(id);
        if (current.status !== 'LOCAL_DRAFT') throw new AppError('This invoice is locked because it has been submitted to PayPal.', 409);
        if (body.version !== current.version) throw new AppError('This invoice changed in another tab. Reload to continue.', 409);
        return save({ ...current, ...validateInvoice(body), error: null });
      });
      if (method !== 'POST' || !action) throw new AppError('Not found.', 404);
      return exclusive(id, async () => {
        let invoice = get(id);
        if (action === 'create-paypal') {
          if (body.approved !== true || body.version !== invoice.version) throw new AppError('Review the current invoice and approve it before creating a PayPal draft.', 409);
          if (invoice.paypalId) return invoice;
          if (invoice.status !== 'LOCAL_DRAFT') throw new AppError('Creation is pending or uncertain. Check your PayPal sandbox dashboard before creating another invoice.', 409);
          validateInvoice(invoice);
          invoice = save({ ...invoice, status: 'CREATING', error: null });
          try {
            const result = await paypal.create(paypalPayload(invoice));
            // Persist the ID before further network calls, so a failed read cannot duplicate a draft.
            invoice = save({ ...invoice, paypalId: result.id, status: 'DRAFT' });
            return save(applyRemote(invoice, remoteValid(await paypal.get(result.id), result.id)));
          } catch (error) {
            save({ ...invoice, status: invoice.paypalId ? 'DRAFT' : error.uncertain ? 'CREATION_UNCERTAIN' : 'LOCAL_DRAFT', error: error.message });
            throw error;
          }
        }
        if (!invoice.paypalId) throw new AppError('Create a PayPal draft first.', 409);
        if (action === 'activate') {
          if (body.approved !== true) throw new AppError('Approve making this invoice payable first.');
          const remote = remoteValid(await paypal.get(invoice.paypalId), invoice.paypalId);
          invoice = save(applyRemote(invoice, remote));
          if (invoice.status === 'DRAFT') {
            try {
              await paypal.activate(invoice.paypalId);
              return save(applyRemote(invoice, remoteValid(await paypal.get(invoice.paypalId), invoice.paypalId)));
            } catch (error) {
              save({ ...invoice, error: 'Could not confirm activation. Refresh the PayPal status before retrying.' });
              throw error;
            }
          }
          return invoice;
        }
        return save(applyRemote(invoice, remoteValid(await paypal.get(invoice.paypalId), invoice.paypalId)));
      });
    },
  };
}

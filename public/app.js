const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const time = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not checked yet';
const terms = { DUE_ON_RECEIPT: 'Due on receipt', NET_15: 'Due in 15 days', NET_30: 'Due in 30 days' };
const names = { LOCAL_DRAFT: 'Draft', CREATING: 'Creating in PayPal', CREATION_UNCERTAIN: 'Needs checking', DRAFT: 'PayPal draft', SENT: 'Awaiting payment', UNPAID: 'Awaiting payment', PAID: 'Paid', MARKED_AS_PAID: 'Marked paid externally', PARTIALLY_PAID: 'Partially paid', PAYMENT_PENDING: 'Payment pending', CANCELLED: 'Cancelled', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partially refunded' };
const status = value => `<span class="status ${value === 'PAID' ? 'positive' : value === 'CREATION_UNCERTAIN' ? 'warning' : ''}">${esc(names[value] || value)}</span>`;
const blankItem = () => ({ name: '', quantity: '1', rate: '', source: '' });
const blankDraft = () => ({ title: '', clientName: '', clientEmail: '', notes: '', customerNote: 'Thank you for your business.', term: 'DUE_ON_RECEIPT', items: [blankItem()], questions: [], summary: '' });
let config = {};
let invoices = [];
let draft = blankDraft();
let editingId = null;
let busy = false;
let filter = 'all';
let search = '';
let toastTimer;
let routeGeneration = 0;
let polling;
let chatgptModels = [];
let modelsAccountId = null;
const usageUrl = 'https://chatgpt.com/#settings/Usage';
try { const saved = JSON.parse(localStorage.getItem('worknote-draft')); if (saved && Array.isArray(saved.items)) { draft = { ...blankDraft(), ...saved }; editingId = saved.localDraftId || null; } } catch { /* A corrupt browser draft starts empty. */ }

function persist() { try { localStorage.setItem('worknote-draft', JSON.stringify({ ...draft, localDraftId: editingId })); } catch { /* Saving on the server remains available. */ } }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('Could not reach the local app. Check that npm start is still running.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed. Please retry.');
  return data;
}
function pageHeader(title, subtitle, action = '') {
  return `<header class="page-header"><div><div class="breadcrumb">Workspace <span>/</span> ${esc(title)}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</header>`;
}
function errorBox(message) { return `<div class="inline-error" role="alert">${esc(message)}</div>`; }
function lineTotal(item) {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(item.quantity) || !/^\d{1,7}(?:\.\d{1,2})?$/.test(item.rate)) return null;
  const hundredths = value => { const [w, f = ''] = value.split('.'); return Number(w) * 100 + Number(f.padEnd(2, '0')); };
  const q = hundredths(item.quantity), r = hundredths(item.rate);
  if (q <= 0 || r <= 0 || !Number.isSafeInteger(q * r)) return null;
  return Math.floor((q * r + 50) / 100);
}
function totalDraft() { return draft.items.reduce((sum, item) => sum + (lineTotal(item) ?? 0), 0); }
function hasContent() { return draft.notes || draft.title || draft.clientName || draft.items.some(item => item.name || item.rate); }
function updateTotals() {
  draft.items.forEach((item, i) => { const el = $(`[data-line-total="${i}"]`); if (el) el.textContent = lineTotal(item) === null ? '—' : money(lineTotal(item)); });
  if ($('#invoice-total')) $('#invoice-total').textContent = money(totalDraft());
  if ($('#total-caption')) $('#total-caption').textContent = draft.items.some(item => lineTotal(item) === null) ? 'Complete every quantity and rate before approval.' : `${draft.items.length} ${draft.items.length === 1 ? 'item' : 'items'} · USD · No tax or discount applied`;
}
function renderEditor() {
  const saved = editingId ? invoices.find(invoice => invoice.id === editingId) : null;
  $('#view').innerHTML = pageHeader(editingId ? 'Edit draft' : 'New invoice', 'Your work, ready to bill.', `<a href="#invoices" class="quiet-link">View invoices <span>↗</span></a>`) + `
    <div class="workflow"><span class="current">Work notes</span><span aria-hidden="true">→</span><span>Review invoice</span><span aria-hidden="true">→</span><span>Get paid</span><span class="workflow-note">You approve every charge.</span></div>
    <div class="composer">
      <section class="notes-panel" aria-labelledby="notes-heading">
        <div class="section-heading"><h2 id="notes-heading">Start with your work</h2><button class="text-button" data-action="example">Load example</button></div>
        <p class="muted">Paste your timesheet, project notes, or a client agreement. Include hours and agreed rates.</p>
        <label for="work-notes">Work notes</label><textarea id="work-notes" data-field="notes" rows="12" maxlength="12000" placeholder="Website updates for a client…&#10;&#10;What did you finish?&#10;How much time did it take?&#10;What rate did you agree?">${esc(draft.notes)}</textarea>
        <div class="notes-footer"><span>USD invoices</span><span id="notes-count">${draft.notes.length.toLocaleString()} / 12,000</span></div>
        <button class="${config.aiConfigured ? 'primary' : 'secondary'} wide" data-action="ai" ${config.aiConfigured ? '' : 'disabled'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5L10 2Z"/></svg>Draft with AI</button>
        <p class="helper">${config.authMode === 'chatgpt' ? `Using ChatGPT plan${config.model ? ` · ${esc(config.model)}` : ' · choose a model in Connections'}. <a href="${usageUrl}" target="_blank" rel="noopener noreferrer">Manage usage ↗</a>` : config.aiConfigured ? 'Your notes are sent to OpenAI to draft invoice items using API billing. Review the result before approval.' : 'AI needs a connection. <a href="#settings">Continue with ChatGPT or add an API key ↗</a>'}</p>
        <div id="ai-error"></div>
        ${draft.summary ? `<div class="extraction"><h3>What the AI found</h3><p>${esc(draft.summary)}</p></div>` : ''}
        ${draft.questions?.length ? `<div class="questions"><h3>Check before billing</h3><ul>${draft.questions.map(question => `<li>${esc(question)}</li>`).join('')}</ul><p class="helper">Resolve these in the editable invoice before approval.</p></div>` : ''}
        <div class="notes-tip"><h3>A clear trail, from note to invoice.</h3><p>AI-drafted items keep their source notes beside them. Missing rates stay blank for you to confirm.</p></div>
      </section>
      <section class="invoice-panel" aria-labelledby="invoice-heading">
        <div class="invoice-top"><div><span class="paper-wordmark">Worknote.</span><h2 id="invoice-heading">Invoice draft</h2></div>${status('LOCAL_DRAFT')}</div>
        <div class="client-grid"><div class="field full"><label for="project-title">Project name</label><input id="project-title" data-field="title" maxlength="120" value="${esc(draft.title)}" placeholder="e.g. November website updates"></div><div class="field"><label for="client-name">Bill to</label><input id="client-name" data-field="clientName" maxlength="150" value="${esc(draft.clientName)}" placeholder="Client or business name"></div><div class="field"><label for="client-email">Sandbox customer email</label><input id="client-email" data-field="clientEmail" type="email" maxlength="254" value="${esc(draft.clientEmail)}" placeholder="Your US test buyer’s email"></div><div class="field"><label for="payment-term">Payment terms</label><select id="payment-term" data-field="term">${Object.entries(terms).map(([value, label]) => `<option value="${value}" ${draft.term === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field currency-field"><span class="field-label">Currency</span><span class="currency-value">USD <span>US dollar</span></span></div></div>
        <div class="line-items"><div class="item-head"><span>Description</span><span>Qty / hours</span><span>Rate</span><span>Amount</span><span></span></div><div id="item-rows">${draft.items.map((item, index) => itemRow(item, index)).join('')}</div><button class="text-button add-line" data-action="add-item">+ Add line item</button></div>
        <div class="invoice-summary"><div><label for="customer-note">Note to customer</label><textarea id="customer-note" data-field="customerNote" rows="2" maxlength="1000">${esc(draft.customerNote)}</textarea></div><div class="total-block"><span>Total due</span><strong id="invoice-total">${money(totalDraft())}</strong><span>USD</span></div></div>
        <p class="helper total-caption" id="total-caption"></p>
        <label class="check-label reviewed-questions" ${draft.questions?.length ? '' : 'hidden'}><input type="checkbox" id="questions-resolved"> I resolved the questions in the work notes.</label>
        <div id="editor-error"></div><footer class="invoice-actions"><span id="save-caption">${saved ? 'Saved draft · changes are saved when you click Save' : 'Draft stays on this browser until saved.'}</span><div><button class="secondary" data-action="save">Save draft</button><button class="primary" data-action="review">Review & approve <span>→</span></button></div></footer>
      </section>
    </div><p class="canvas-footer">PayPal sandbox · No real money moves. Invoice emails are disabled.</p>`;
  updateTotals();
}
function itemRow(item, index) {
  return `<div class="item-row"><div class="description-cell"><label class="sr-only" for="item-name-${index}">Item ${index + 1} description</label><input id="item-name-${index}" data-item="${index}" data-key="name" value="${esc(item.name)}" placeholder="Describe the work" maxlength="180">${item.source ? `<details class="source-note"><summary>Source from your notes</summary><p>“${esc(item.source)}”</p></details>` : ''}</div><div><label class="sr-only" for="item-qty-${index}">Item ${index + 1} quantity</label><input id="item-qty-${index}" data-item="${index}" data-key="quantity" inputmode="decimal" value="${esc(item.quantity)}" placeholder="1"></div><div><label class="sr-only" for="item-rate-${index}">Item ${index + 1} rate in USD</label><input id="item-rate-${index}" data-item="${index}" data-key="rate" inputmode="decimal" value="${esc(item.rate)}" placeholder="0.00"></div><span class="line-amount" data-line-total="${index}">—</span><button class="remove-item" data-action="remove-item" data-index="${index}" aria-label="Remove item ${index + 1}" ${draft.items.length === 1 ? 'disabled' : ''}>×</button></div>`;
}
async function loadInvoices() { ({ invoices } = await api('/api/invoices')); }
function renderList() {
  const paid = invoices.filter(invoice => invoice.status === 'PAID');
  const waiting = invoices.filter(invoice => ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING'].includes(invoice.status));
  $('#view').innerHTML = pageHeader('Invoices', 'Keep the work and the payment in one place.', '<button class="primary" data-action="new">+ New invoice</button>') + `
    <section class="ledger-summary" aria-label="Invoice summary"><div><span>Paid invoices</span><strong>${money(paid.reduce((sum, invoice) => sum + invoice.totalCents, 0))}</strong><small>${paid.length} confirmed by PayPal</small></div><div><span>Awaiting payment</span><strong>${waiting.length}</strong><small>Invoices waiting on a customer</small></div><div><span>Drafts</span><strong>${invoices.filter(invoice => ['LOCAL_DRAFT', 'DRAFT'].includes(invoice.status)).length}</strong><small>Ready for your next review</small></div></section>
    <section class="ledger-panel"><div class="list-tools"><div class="tabs" role="group" aria-label="Filter invoices">${[['all', 'All invoices'], ['drafts', 'Drafts'], ['waiting', 'Awaiting payment'], ['paid', 'Paid']].map(([value, label]) => `<button class="tab ${filter === value ? 'active' : ''}" data-action="filter" data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div><label class="search-label"><span class="sr-only">Search invoices</span><input id="invoice-search" type="search" placeholder="Search client or project" value="${esc(search)}"></label></div><div id="invoice-list"></div></section><p class="canvas-footer">Statuses update when you open an invoice and every 30 seconds while its detail is visible.</p>`;
  renderRows();
}
function renderRows() {
  const filtered = invoices.filter(invoice => {
    const category = filter === 'all' || filter === 'drafts' && ['LOCAL_DRAFT', 'DRAFT'].includes(invoice.status) || filter === 'paid' && invoice.status === 'PAID' || filter === 'waiting' && ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING'].includes(invoice.status);
    return category && `${invoice.title} ${invoice.clientName} ${invoice.number}`.toLowerCase().includes(search.toLowerCase());
  });
  $('#invoice-list').innerHTML = filtered.length ? `<div class="invoice-table"><div class="table-header"><span>Project / client</span><span>Created</span><span>Status</span><span>Amount</span><span></span></div>${filtered.map(invoice => `<a href="#invoice/${invoice.id}" class="invoice-table-row"><div><strong>${esc(invoice.title)}</strong><small>${esc(invoice.clientName)}</small></div><span>${esc(new Date(invoice.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span><div>${status(invoice.status)}</div><strong class="num">${money(invoice.totalCents)}</strong><span aria-hidden="true">↗</span></a>`).join('')}</div><p class="list-count">${filtered.length} ${filtered.length === 1 ? 'invoice' : 'invoices'}</p>` : `<div class="empty-state"><h2>${invoices.length ? 'No matching invoices' : 'Your first invoice starts here.'}</h2><p>${invoices.length ? 'Try another filter or search.' : 'Turn your work notes into a reviewed invoice, then track it through payment.'}</p>${invoices.length ? '' : '<button class="primary" data-action="new">Create an invoice →</button><button class="text-button" data-action="import">Import your earlier sandbox test</button>'}</div>`;
}
function renderDetail(invoice) {
  const local = invoice.status === 'LOCAL_DRAFT';
  $('#view').innerHTML = pageHeader('Invoice details', invoice.number, '<a href="#invoices" class="quiet-link">← All invoices</a>') + `
    <div class="detail-grid"><section class="invoice-panel detail-paper"><div class="invoice-top"><div><span class="paper-wordmark">Worknote.</span><h2>${esc(invoice.title)}</h2></div>${status(invoice.status)}</div><div class="detail-client"><div><span>Bill to</span><strong>${esc(invoice.clientName)}</strong><p>${esc(invoice.clientEmail || 'Imported sandbox test')}</p></div><div><span>Payment terms</span><p>${esc(terms[invoice.term] || invoice.term)}</p></div></div><div class="detail-lines"><div class="detail-line headings"><span>Description</span><span>Qty</span><span>Rate</span><span>Amount</span></div>${invoice.items.map(item => `<div class="detail-line"><div>${esc(item.name)}${item.source ? `<small>From your notes: “${esc(item.source)}”</small>` : ''}</div><span>${esc(item.quantity)}</span><span>${money(Math.round(Number(item.rate) * 100))}</span><strong>${lineTotal(item) === null ? '—' : money(lineTotal(item))}</strong></div>`).join('')}</div><div class="invoice-summary"><div><span class="field-label">Note to customer</span><p>${esc(invoice.customerNote || '—')}</p></div><div class="total-block"><span>Invoice total</span><strong>${money(invoice.totalCents)}</strong><span>USD</span></div></div>${invoice.notes ? `<details class="original-notes"><summary>Original work notes</summary><p>${esc(invoice.notes)}</p></details>` : ''}</section>
    <aside class="payment-panel"><h2>${invoice.status === 'PAID' ? 'Payment received.' : local ? 'Ready for review.' : 'The payment trail'}</h2><p class="muted">${invoice.status === 'PAID' ? 'PayPal has confirmed this sandbox invoice as paid.' : local ? 'Your saved draft has not been created in PayPal yet.' : 'Status comes directly from your PayPal sandbox account.'}</p><ol class="payment-trail"><li class="done"><span></span><div>Invoice drafted<small>${time(invoice.createdAt)}</small></div></li><li class="${invoice.paypalId ? 'done' : ''}"><span></span><div>Created in PayPal<small>${invoice.paypalId ? esc(invoice.paypalId) : 'Waiting for your approval'}</small></div></li><li class="${invoice.paymentUrl && invoice.status !== 'DRAFT' ? 'done' : ''}"><span></span><div>Payment link ready<small>${invoice.paymentUrl && invoice.status !== 'DRAFT' ? 'Share the sandbox link with your test buyer' : 'No email notifications'}</small></div></li><li class="${invoice.status === 'PAID' ? 'done paid-step' : ''}"><span></span><div>Payment confirmed<small>${invoice.status === 'PAID' ? 'Confirmed by PayPal' : 'Waiting for a sandbox payment'}</small></div></li></ol>
    <div id="detail-error">${invoice.error ? errorBox(invoice.error) : ''}</div>
    ${local ? `<button class="primary wide" data-action="edit" data-id="${invoice.id}">Review saved draft →</button>` : invoice.status === 'DRAFT' ? `<button class="primary wide" data-action="activate" data-id="${invoice.id}">Make payable & get link →</button><p class="helper">Creates a shareable sandbox payment link. Email notifications stay off.</p>` : ''}
    ${invoice.paymentUrl && !['DRAFT', 'CANCELLED', 'CREATION_UNCERTAIN'].includes(invoice.status) ? `<a class="${invoice.status === 'PAID' ? 'secondary' : 'primary'} wide" href="${esc(invoice.paymentUrl)}" target="_blank" rel="noopener noreferrer">${invoice.status === 'PAID' ? 'View sandbox receipt' : 'Open sandbox payment page'} ↗</a><button class="secondary wide" data-action="copy" data-url="${esc(invoice.paymentUrl)}">Copy payment link</button>` : ''}
    ${invoice.paypalId ? `<button class="text-button wide" data-action="refresh" data-id="${invoice.id}">↻ Refresh PayPal status</button><p class="helper checked-at">Last checked ${time(invoice.checkedAt)}</p>` : ''}
    ${['CREATING', 'CREATION_UNCERTAIN'].includes(invoice.status) ? `<p class="helper">Check invoice number <strong>${esc(invoice.number)}</strong> in your sandbox dashboard. A retry is blocked to prevent duplicate invoices.</p><a class="secondary wide" href="https://www.sandbox.paypal.com/invoice/s/manage" target="_blank" rel="noopener noreferrer">Open sandbox dashboard ↗</a>` : ''}
    <p class="payment-note">Sandbox only. Use your US Personal test account to pay an India Business test account.</p></aside></div>`;
}
function chatgptSettings() {
  const connection = config.chatgpt ?? { accounts: [], active: null };
  const active = connection.active;
  const connected = active?.connected && active?.planEnabled;
  const modelsReady = modelsAccountId === active?.id && chatgptModels.length;
  return `<section class="settings-row"><div><h2>Use your ChatGPT plan</h2><p>Connect your eligible ChatGPT account to draft invoices with your plan’s usage. Worknote does not charge a subscription.</p><a href="${usageUrl}" target="_blank" rel="noopener noreferrer" class="quiet-link">Manage ChatGPT usage ↗</a></div><div class="settings-panel"><div class="connection-title"><strong>ChatGPT</strong><span class="status">${connected ? 'Plan authorized' : active?.connected ? 'Plan permission needed' : 'Not connected'}</span></div>
    <p>${connected ? `Using ChatGPT plan · ${esc(active.label)}. Drafting shares your plan’s usage limits. Your selection below applies to AI drafting only.` : 'Continue with ChatGPT to review OpenAI’s sign-in and plan-usage permissions. No API key is needed for this connection.'}</p>
    ${connection.accounts.length ? `<label for="chatgpt-account">Saved ChatGPT account</label><select id="chatgpt-account">${connection.accounts.map(account => `<option value="${esc(account.id)}" ${active?.id === account.id ? 'selected' : ''}>${esc(account.label)}${account.connected ? '' : ' (signed out)'}</option>`).join('')}</select><button class="text-button" data-action="chatgpt-account">Use selected account</button>` : ''}
    <div class="connection-actions"><button class="secondary" data-action="chatgpt-login" ${active ? `data-account="${esc(active.id)}"` : ''}>Continue with ChatGPT</button>${connection.accounts.length ? '<button class="text-button" data-action="chatgpt-login">Add another account</button>' : ''}</div>
    ${connected ? `<div class="model-connection"><label for="chatgpt-model">Invoice drafting model</label><select id="chatgpt-model" ${modelsReady ? '' : 'disabled'}><option value="">${modelsReady ? 'Choose an available model' : active.model ? esc(active.model) : 'Load models from your account'}</option>${modelsReady ? chatgptModels.map(model => `<option value="${esc(model.id)}" ${active.model === model.id ? 'selected' : ''}>${esc(model.name)}</option>`).join('') : ''}</select><div class="connection-actions"><button class="text-button" data-action="chatgpt-models">↻ Load available models</button>${modelsReady ? '<button class="secondary" data-action="chatgpt-save-model">Use this model</button>' : ''}</div></div>` : ''}
    ${active?.connected ? '<button class="text-button" data-action="chatgpt-sign-out">Sign out of this ChatGPT account</button>' : ''}<div id="chatgpt-error"></div><p class="helper">This sign-in integration is for the local, open-source app. Access depends on your account and OpenAI’s current preview availability.</p></div></section>`;
}
function renderSettings() {
  $('#view').innerHTML = pageHeader('Connections', 'Your credentials stay on the server, outside the browser.') + chatgptSettings() + `<section class="settings-row"><div><h2>PayPal sandbox</h2><p>Create test invoices and check payment status using your sandbox app.</p></div><div class="settings-panel"><div class="connection-title"><strong>PayPal</strong><span class="status">${config.paypalConfigured ? 'Credentials saved' : 'Setup needed'}</span></div><p>${config.paypalConfigured ? 'Sandbox client ID and secret are present. Test the connection to verify them.' : 'Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local, then restart.'}</p><button class="secondary" data-action="test-paypal">Test connection</button><div id="connection-result" role="status"></div></div></section><section class="settings-row"><div><h2>API key alternative</h2><p>Use a separately billed OpenAI API key instead of ChatGPT plan usage.</p></div><div class="settings-panel"><div class="connection-title"><strong>OpenAI API</strong><span class="status">${config.authMode === 'api-key' ? 'Key configured' : 'API key needed'}</span></div><p>${config.authMode === 'api-key' ? `Configured model: ${esc(config.model)}. Draft an invoice to test model access.` : 'An API key is optional when ChatGPT plan usage is connected. Otherwise add one to .env.local and restart npm start.'}</p><pre><code>OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4.1-mini</code></pre><p class="helper">Work notes are sent to OpenAI only when you choose “Draft with AI”. API billing is separate from a ChatGPT subscription.</p><a class="quiet-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Manage API keys ↗</a></div></section><section class="settings-row"><div><h2>Your first payment</h2><p>Bring the sandbox invoice you already tested into this workspace.</p></div><div class="settings-panel"><p>We retrieve its current status from PayPal. Existing imported invoices won’t be duplicated.</p><button class="secondary" data-action="import">Import sandbox test invoice</button></div></section><section class="settings-row"><div><h2>Local workspace</h2><p>This version runs on your Mac for one user.</p></div><div class="settings-panel"><p>Saved invoices live in <code>data/worknote.sqlite</code>. Unsaved work notes stay in this browser. Credentials and invoice data are excluded from Git.</p><button class="text-button" data-action="reload-config">↻ Refresh connection settings</button><p class="helper">Restart the server after changing .env.local.</p></div></section>`;
}
function showChatGPTWelcome() {
  const active = config.chatgpt?.active;
  if (active?.connected && active.planEnabled && !active.welcomed) {
    const dialog = $('#chatgpt-welcome');
    if (!dialog.open) dialog.showModal();
  }
}
async function route() {
  const generation = ++routeGeneration;
  clearInterval(polling);
  $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  const route = location.hash.slice(1) || 'new';
  document.querySelectorAll('[data-route]').forEach(link => { const active = route.startsWith(link.dataset.route) || link.dataset.route === 'invoices' && route.startsWith('invoice/'); link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  try {
    if (route.startsWith('invoice/')) {
      const id = route.split('/')[1];
      let invoice = await api(`/api/invoices/${encodeURIComponent(id)}`);
      if (generation !== routeGeneration) return;
      renderDetail(invoice);
      if (invoice.paypalId) {
        const refresh = async () => {
          if (document.hidden || busy) return;
          try { invoice = await api(`/api/invoices/${id}/refresh`, 'POST', {}); if (generation === routeGeneration) renderDetail(invoice); }
          catch (error) { if (generation === routeGeneration && $('#detail-error')) $('#detail-error').innerHTML = errorBox(`${error.message} Showing the last saved status.`); }
        };
        await refresh();
        if (generation === routeGeneration) polling = setInterval(refresh, 30000);
      }
    } else if (route === 'invoices') { await loadInvoices(); if (generation === routeGeneration) renderList(); }
    else if (route === 'settings') { renderSettings(); showChatGPTWelcome(); }
    else renderEditor();
  } catch (error) { if (generation === routeGeneration) $('#view').innerHTML = pageHeader('Workspace', 'We couldn’t load this view.') + errorBox(error.message) + '<button class="secondary" data-action="retry">Retry</button>'; }
}
function validateDraft() {
  if (!draft.title.trim() || !draft.clientName.trim()) throw new Error('Add the project and client names.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.clientEmail.trim())) throw new Error('Add the sandbox customer’s email address.');
  if (!draft.items.length || draft.items.some(item => !item.name.trim() || lineTotal(item) === null)) throw new Error('Complete the description, positive quantity, and rate for every item.');
}
async function saveDraft() {
  validateDraft();
  let saved;
  if (editingId) {
    const current = invoices.find(invoice => invoice.id === editingId);
    saved = await api(`/api/invoices/${editingId}`, 'PUT', { ...draft, version: current.version });
  } else saved = await api('/api/invoices', 'POST', draft);
  editingId = saved.id;
  invoices = [saved, ...invoices.filter(invoice => invoice.id !== saved.id)];
  persist();
  return saved;
}
function approveDialog() {
  $('#approval-copy').textContent = `${draft.clientName} · ${draft.clientEmail} · ${money(totalDraft())} USD`;
  $('#approval-check').checked = false; $('#confirm-approval').disabled = true;
  $('#approval-dialog').showModal();
  return new Promise(resolve => $('#approval-dialog').addEventListener('close', () => resolve($('#approval-dialog').returnValue === 'approve'), { once: true }));
}
async function runAction(button, fn, errorTarget) {
  if (busy) return;
  busy = true; button.disabled = true;
  const original = button.innerHTML; button.textContent = 'Working…';
  if (errorTarget && $(errorTarget)) $(errorTarget).innerHTML = '';
  try { await fn(); }
  catch (error) { if (errorTarget && $(errorTarget)) $(errorTarget).innerHTML = errorBox(error.message); else toast(error.message); }
  finally { busy = false; if (button.isConnected) { button.disabled = false; button.innerHTML = original; } }
}

document.addEventListener('input', event => {
  const el = event.target;
  if (el.dataset.field) { draft[el.dataset.field] = el.value; persist(); if (el.id === 'work-notes') $('#notes-count').textContent = `${el.value.length.toLocaleString()} / 12,000`; }
  if (el.dataset.item !== undefined) { draft.items[Number(el.dataset.item)][el.dataset.key] = el.value; persist(); updateTotals(); }
  if (el.id === 'invoice-search') { search = el.value; renderRows(); }
  if (el.id === 'approval-check') $('#confirm-approval').disabled = !el.checked;
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (busy) return;
  if (action === 'new') {
    if (hasContent() && !confirm('Start a new invoice? Unsaved work in the current editor will be cleared.')) return;
    draft = blankDraft(); editingId = null; persist(); location.hash = 'new'; renderEditor(); return;
  }
  if (action === 'example') {
    if (hasContent() && !confirm('Replace the current editor with example work notes and invoice items?')) return;
    draft = { ...blankDraft(), title: 'Website launch support', clientName: 'Northstar Studio', notes: 'Completed website launch support for Northstar Studio.\nHomepage implementation: 4 hours at $60/hour.\nMobile layout fixes: 2 hours at $45/hour.\nDeployment handover: fixed fee of $50.\nAll work is complete. Payment due on receipt.', items: [{ name: 'Homepage implementation', quantity: '4', rate: '60.00', source: '' }, { name: 'Mobile layout fixes', quantity: '2', rate: '45.00', source: '' }, { name: 'Deployment handover', quantity: '1', rate: '50.00', source: '' }] };
    editingId = null; persist(); renderEditor(); toast('Example loaded. These items are sample data, not an AI result. Add your US sandbox buyer’s email to test.'); return;
  }
  if (action === 'add-item') { if (draft.items.length >= 25) return toast('This version supports up to 25 invoice items.'); draft.items.push(blankItem()); persist(); renderEditor(); $(`#item-name-${draft.items.length - 1}`).focus(); return; }
  if (action === 'remove-item') { if (draft.items.length > 1) draft.items.splice(Number(button.dataset.index), 1); persist(); renderEditor(); return; }
  if (action === 'filter') { filter = button.dataset.filter; renderList(); return; }
  if (action === 'edit') return runAction(button, async () => { const invoice = await api(`/api/invoices/${button.dataset.id}`); draft = { ...invoice, questions: [], summary: '' }; editingId = invoice.id; invoices = [invoice, ...invoices.filter(value => value.id !== invoice.id)]; persist(); location.hash = 'new'; }, '#detail-error');
  if (action === 'copy') { try { await navigator.clipboard.writeText(button.dataset.url); toast('Sandbox payment link copied.'); } catch { toast('Copy the link from the sandbox payment page address bar.'); } return; }
  if (action === 'retry') return route();
  if (action === 'chatgpt-login') return runAction(button, async () => {
    const result = await api('/api/chatgpt/start', 'POST', { accountId: button.dataset.account || null });
    const url = new URL(result.authorizationUrl);
    if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in destination.');
    window.location.assign(url.href);
  }, '#chatgpt-error');
  if (action === 'chatgpt-account') return runAction(button, async () => {
    await api('/api/chatgpt/select-account', 'POST', { accountId: $('#chatgpt-account').value });
    config = await api('/api/config'); chatgptModels = []; modelsAccountId = null; renderSettings(); showChatGPTWelcome();
  }, '#chatgpt-error');
  if (action === 'chatgpt-models') return runAction(button, async () => {
    const result = await api('/api/chatgpt/models');
    chatgptModels = result.models; modelsAccountId = config.chatgpt.active.id; renderSettings();
    if (!chatgptModels.length) $('#chatgpt-error').innerHTML = errorBox('No models are available to this account. Review ChatGPT usage settings or reconnect.');
  }, '#chatgpt-error');
  if (action === 'chatgpt-save-model') return runAction(button, async () => {
    await api('/api/chatgpt/model', 'POST', { model: $('#chatgpt-model').value });
    config = await api('/api/config'); renderSettings(); toast('ChatGPT model selected. You can draft an invoice now.');
  }, '#chatgpt-error');
  if (action === 'chatgpt-sign-out') return runAction(button, async () => {
    const result = await api('/api/chatgpt/sign-out', 'POST', {});
    config = await api('/api/config'); chatgptModels = []; modelsAccountId = null; renderSettings();
    toast(result.revoked ? 'Signed out of ChatGPT on this Mac.' : 'Signed out locally. Remote revocation could not be confirmed; disconnect Worknote in ChatGPT settings.');
  }, '#chatgpt-error');
  if (action === 'chatgpt-welcome') return runAction(button, async () => {
    await api('/api/chatgpt/welcome', 'POST', {});
    config = await api('/api/config'); $('#chatgpt-welcome').close();
  });
  if (action === 'reload-config') return runAction(button, async () => { config = await api('/api/config'); renderSettings(); toast('Connection settings refreshed.'); });
  if (action === 'ai') return runAction(button, async () => {
    if (draft.items.some(item => item.name || item.rate) && !confirm('Replace the current line items with a new AI draft?')) return;
    const notesSnapshot = draft.notes;
    const result = await api('/api/ai/draft', 'POST', { notes: notesSnapshot });
    if (draft.notes !== notesSnapshot) throw new Error('The notes changed while drafting. Please try again with the updated notes.');
    draft = { ...draft, title: result.title || draft.title, customerNote: result.customerNote, items: result.items.length ? result.items : [blankItem()], questions: result.questions, summary: result.summary };
    persist(); renderEditor(); toast('AI draft ready. Check every charge and any missing details.');
  }, '#ai-error');
  if (action === 'save') return runAction(button, async () => { const saved = await saveDraft(); $('#save-caption').textContent = `Saved ${time(saved.updatedAt)}`; toast('Draft saved to this Mac.'); }, '#editor-error');
  if (action === 'review') {
    try { validateDraft(); if (draft.questions?.length && !$('#questions-resolved')?.checked) throw new Error('Resolve the AI questions and check the confirmation above before approval.'); }
    catch (error) { $('#editor-error').innerHTML = errorBox(error.message); return; }
    if (!await approveDialog()) return;
    return runAction(button, async () => {
      const saved = await saveDraft();
      try { await api(`/api/invoices/${saved.id}/create-paypal`, 'POST', { approved: true, version: saved.version }); }
      catch (error) { location.hash = `invoice/${saved.id}`; throw error; }
      draft = blankDraft(); editingId = null; persist(); location.hash = `invoice/${saved.id}`;
    }, '#editor-error');
  }
  if (action === 'activate') return runAction(button, async () => { await api(`/api/invoices/${button.dataset.id}/activate`, 'POST', { approved: true }); await route(); toast('Sandbox payment link ready. No email notifications were sent.'); }, '#detail-error');
  if (action === 'refresh') return runAction(button, async () => { const invoice = await api(`/api/invoices/${button.dataset.id}/refresh`, 'POST', {}); renderDetail(invoice); toast('Payment status checked with PayPal.'); }, '#detail-error');
  if (action === 'test-paypal') return runAction(button, async () => { await api('/api/paypal/test', 'POST', {}); $('#connection-result').textContent = 'Connected to PayPal sandbox.'; }, '#connection-result');
  if (action === 'import') return runAction(button, async () => { const invoice = await api('/api/import-test', 'POST', {}); location.hash = `invoice/${invoice.id}`; toast('Your sandbox test invoice was imported.'); });
});
$('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
window.addEventListener('hashchange', route);
try { config = await api('/api/config'); await loadInvoices(); if (editingId && !invoices.some(invoice => invoice.id === editingId && invoice.status === 'LOCAL_DRAFT')) { editingId = null; persist(); } await route(); }
catch (error) { $('#view').innerHTML = pageHeader('Workspace', 'Start the local server to continue.') + errorBox(error.message); }

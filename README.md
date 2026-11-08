# Worknote

A local, single-user freelance billing app. Turn work notes into an editable invoice, approve the charges, create a PayPal sandbox draft, generate its payment link, and retrieve payment status.

## Run

Requires Node.js 22.13 or later (the app uses built-in SQLite). No package installation is needed.

```sh
cp .env.example .env.local  # Only for a new setup; do not overwrite an existing credentials file.
npm start
```

Open http://127.0.0.1:3000. Stop with Ctrl+C. `npm run dev` restarts the server when server files change; refresh the browser for frontend changes.

Set these in `.env.local`:

```dotenv
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
PAYPAL_ENVIRONMENT=sandbox
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
```

AI drafting supports either authorized ChatGPT plan usage or a separately billed OpenAI API key. Without either connection, the app explicitly disables AI drafting; manual invoice editing, clearly labeled sample content, and PayPal operations still work. A Codex login file is never read or reused. Restart after changing environment variables.

## Use an eligible ChatGPT plan

No OpenAI API key or OAuth client secret is needed for this local sign-in route:

1. Start or restart the app with `npm start`. Open http://127.0.0.1:3000/#settings (replace the port if configured).
2. Under Use your ChatGPT plan, click Continue with ChatGPT. The browser navigates to OpenAI's authorization page. Sign in with your eligible account and review the requested plan-usage permission.
3. OpenAI returns to `http://127.0.0.1:3000/auth/callback`. The callback uses `127.0.0.1`, not `localhost`, as required by the documented local flow.
4. Dismiss the first-use explanation, click Load available models, choose a model, and click Use this model. Choices are fetched from your account; no model is assumed to be included in your plan.
5. Open New invoice and choose Draft with AI. Eligible requests use your plan and share its usage limits. Manage usage and access in ChatGPT settings. Availability is subject to OpenAI's preview and your account eligibility.

Sign in again through the same saved account when reauthorization is needed; add another account through Add another account. The saved account picker keeps registrations distinct even when email addresses match. Sign out attempts remote session revocation and clears the local tokens; if revocation cannot be confirmed, the app tells you to disconnect it in ChatGPT settings.

The app creates its own dynamic OAuth registration and stable host ID. OAuth credentials are written atomically with owner-only permissions to ignored `data/chatgpt-auth.json`. State, nonce, PKCE, signed ID-token identity, audience and expiry are checked. The current verifier accepts RS256 identity tokens and rejects other algorithms. Responses stream from the public OpenAI API with `store: false`; unsupported preview parameters are omitted. A failed plan request does not silently fall back to a paid API key.

This route is for the local, open-source app; availability for a remotely hosted service is separate. Each person running the app authorizes their own eligible account. This sign-in route has been manually exercised locally with AI invoice drafting and missing-rate detection. If the server is forcibly killed during a protected credential operation, a stale `data/chatgpt-auth.json.lock` can remain; remove it only after confirming all Worknote server processes are stopped.

## End-to-end test

1. Create a sandbox Business account and app in the PayPal Developer Dashboard.
2. Create a separate sandbox Personal buyer account. If your merchant is in India, use a US sandbox buyer to test a cross-border payment; India-to-India payments are not supported.
3. Open Connections and test PayPal authentication. For a new installation, create your first invoice in the app. The optional Import sandbox test action applies only if you previously ran `scripts/test-paypal.mjs` with the same merchant credentials.
4. Open New invoice and paste completed work, hours, and agreed rates. Click Draft with AI (notes are sent to OpenAI with `store: false`). Missing pricing stays blank and questions appear. The source quote is shown beside each extracted item. AI never creates or pays an invoice.
5. Review the client, sandbox buyer email, item quantities, rates, terms, and total. Resolve questions. Approve the confirmation to create a PayPal draft.
6. Open the detail and choose Make payable & get link. The server uses the PayPal send endpoint with both email flags disabled. No invoice emails are sent.
7. Open the link in a private browser window, sign in as the Personal sandbox buyer, and pay with simulated funds. Never enter real card details.
8. Return to Worknote and refresh status. The detail polls every 30 seconds while visible. `PAID` is shown only when retrieved from PayPal; recording a fake external payment is not used.

## Data and limits

- Local-only: the server binds to `127.0.0.1`. Host/origin checks reject cross-site requests. This is not a multi-user hosted service and has no account login. Add proper authentication and per-user storage before deployment.
- PayPal/API-key credentials remain in the server environment; ChatGPT OAuth credentials remain in the protected local credential file. Neither is returned by the app API. `.env.local`, `data/`, and the sandbox test pointer are ignored by Git.
- Saved invoices are stored in `data/worknote.sqlite`; unsaved editor contents are retained in this browser's local storage. Both may contain customer information. Back up the database if needed; clear local storage when using a shared browser.
- USD, positive quantities/rates with up to two decimal places, at most 25 invoice items. Monetary arithmetic uses integer cents and hundredths of quantities, rounding each line half-up. No tax, discounts, currency conversion, attachments, refunds, recurring payments, or automated reminders are implemented.
- Status is read from PayPal; webhooks are not implemented in this local prototype. Failed refreshes preserve the last confirmed status and timestamp.
- Concurrent operations on one invoice are blocked. A PayPal creation with an ambiguous response is not automatically retried. Find the invoice number in the sandbox dashboard before taking further action. If the ID was received, it is saved before retrieving details.
- To keep the complete review available, PayPal invoices are locked for editing in this app after creation. Edit a local draft before approval.
- The example is fictitious Northstar Studio work: 4 × $60, 2 × $45, and a $50 fixed fee, totaling $380. It is visibly identified as sample content, not AI output or actual revenue.

## Checks

```sh
npm test
npm run check
npm run check:public
```

The automated tests mock PayPal and OpenAI at their boundaries and never move money. The public-file checker scans candidate files for private runtime files, known credential formats, and exact matches to local credentials without printing secret values. It reduces accidental exposure but is not a guarantee that every possible secret format is detected.

An optional sandbox smoke test is available:

```sh
node --env-file=.env.local scripts/test-paypal.mjs
```

## Official references

- [PayPal sandbox](https://developer.paypal.com/sandbox-testing/overview)
- [Create invoice](https://developer.paypal.com/api/invoicing/v2/invoices-create)
- [Make invoice payable with email disabled](https://developer.paypal.com/api/invoicing/v2/invoices-send)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [ChatGPT plan usage for local open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [OAuth registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Plan inference preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Verification and current scope

The automated suite covers invoice validation and integer-cent totals, explicit approval, concurrency and duplicate prevention, OAuth state/PKCE/identity checks, token renewal, account-specific model choices, interrupted AI streams, HTML escaping, and local request protections. The developer has manually exercised sandbox invoice creation, a sandbox payment and status retrieval, ChatGPT sign-in, and AI invoice drafting with a missing-rate question. No automated live-provider or full-browser end-to-end test is claimed.

This is a hackathon prototype for a single local workspace. It has no hosted deployment, multi-user authentication, or webhook endpoint. Source and instructions are included so a reviewer can run it locally.

## Reviewer setup

Follow Run, connect a sandbox merchant app, and authorize AI access using either your own eligible ChatGPT account or an API key. The repository deliberately includes no shared passwords, merchant credentials, OAuth tokens, customer records, or preloaded paid invoices. Any entrant-provided judging access must be arranged separately through the submission's private testing instructions. Without AI access the manual workflow remains available, but it does not demonstrate the AI requirement.

## License

[MIT](LICENSE).

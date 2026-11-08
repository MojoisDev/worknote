import { AppError } from './domain.mjs';

export function localHost(req, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
}

export function trustedApiRequest(req, port) {
  if (!localHost(req, port)) return false;
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

export function createHttpHandler({ app, chatgpt, port, readStatic }) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Host checks apply everywhere. Static assets contain no secrets or side effects;
      // loading the app from an external link or OAuth redirect must remain possible.
      if (!localHost(req, port)) throw new AppError('Requests must come from the local app.', 403);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/auth/callback' && req.headers.host === `127.0.0.1:${port}`) {
        try {
          await chatgpt.callback(url.searchParams);
          res.writeHead(303, { Location: '/#settings' }); res.end();
        } catch (error) {
          const message = error instanceof AppError ? error.message : 'Sign-in could not be completed. Please return to Connections and retry.';
          const safe = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Worknote sign-in</title><body><h1>Sign-in needs another try</h1><p>${safe}</p><a href="/#settings">Return to Worknote Connections</a></body></html>`);
        }
        return;
      }
      if (path.startsWith('/api/')) {
        if (!trustedApiRequest(req, port)) throw new AppError('Requests must come from the local app.', 403);
        if (!['GET', 'POST', 'PUT'].includes(req.method)) throw new AppError('Method not allowed.', 405);
        let body = {};
        if (req.method !== 'GET') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Send JSON data.', 415);
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 100000) throw new AppError('The request is too large.', 413);
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
          catch { throw new AppError('The request contains invalid JSON.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Send a JSON object.');
        }
        const result = await app.handle(req.method, path, body);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
      } else {
        const entry = staticFiles[path];
        if (req.method !== 'GET' || !entry) throw new AppError('Not found.', 404);
        const content = await readStatic(entry[0]);
        res.writeHead(200, { 'Content-Type': entry[1] }); res.end(content);
      }
    } catch (error) {
      res.writeHead(error instanceof AppError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof AppError ? error.message : 'Something went wrong. Please retry.', uncertain: Boolean(error.uncertain) }));
    }
  };
}

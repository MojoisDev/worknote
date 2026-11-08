import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/store.mjs';
import { createPaypal } from './lib/paypal.mjs';
import { createAI } from './lib/ai.mjs';
import { createApplication } from './lib/application.mjs';
import { createHttpHandler } from './lib/http.mjs';
import { createChatGPT } from './lib/chatgpt.mjs';

const root = new URL('./', import.meta.url);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const store = openStore(fileURLToPath(new URL('./data/worknote.sqlite', root)));
const chatgpt = createChatGPT({ file: fileURLToPath(new URL('./data/chatgpt-auth.json', root)), port });
const app = createApplication({ store, paypal: createPaypal(process.env), ai: createAI(process.env, fetch, chatgpt), chatgpt, testStateFile: new URL('./.sandbox-test.json', root) });
const server = createServer(createHttpHandler({
  app, chatgpt, port,
  readStatic: file => readFile(new URL(`./public/${file}`, root)),
}));
server.listen(port, '127.0.0.1', () => console.log(`Worknote is ready at http://127.0.0.1:${port} (PayPal sandbox only)`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT=3001 in .env.local.` : `Server could not start: ${error.code}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));

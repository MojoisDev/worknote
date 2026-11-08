import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Never print a matched secret. Compare the publication files against local credentials
// and common credential formats, reporting only the filename and category.
const staged = process.argv.includes('--staged');
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10000000 });
const files = [...new Set(git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
const secrets = new Set();
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|OPENAI_API_KEY)\s*=\s*(.*?)\s*$/);
    if (match) { const value = match[2].replace(/^(['"])(.*)\1$/, '$2'); if (value.length >= 12) secrets.add(value); }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const auth = JSON.parse(readFileSync('data/chatgpt-auth.json', 'utf8'));
  for (const account of auth.accounts ?? []) for (const key of ['access_token', 'refresh_token', 'id_token']) if (typeof account[key] === 'string' && account[key].length >= 12) secrets.add(account[key]);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const blocked = /(^|\/)(?:data|node_modules|\.taste-skill|\.git)(\/|$)|(^|\/)\.env(?:\..+)?$|(^|\/)\.sandbox-test\.json$|\.(?:sqlite(?:3)?(?:-.*)?|db|pem|key|p12|pfx|log)$/i;
const formats = [
  ['OpenAI key format', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b/],
  ['GitHub token format', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['user-specific local path', /\/Users\/[^/\s]+\/(?:Projects|Downloads|Pictures|Desktop)\//],
];
let failures = 0;
for (const file of files) {
  if (blocked.test(file) && file !== '.env.example') { console.error(`${file}: private/runtime file must not be published`); failures++; continue; }
  const content = staged ? execFileSync('git', ['show', `:${file}`], { maxBuffer: 10000000 }).toString() : readFileSync(file, 'utf8');
  if ([...secrets].some(secret => content.includes(secret))) { console.error(`${file}: matches a local credential`); failures++; }
  for (const [label, pattern] of formats) if (pattern.test(content)) { console.error(`${file}: ${label}`); failures++; }
}
if (failures) { console.error(`Public-file check failed (${failures} findings). No secret values were printed.`); process.exitCode = 1; }
else console.log(`Public-file check passed for ${files.length} ${staged ? 'staged' : 'candidate'} files. No local credentials, known token formats, or private runtime paths found.`);

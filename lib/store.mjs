import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)');
  return {
    list: () => db.prepare('SELECT data FROM invoices ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)),
    get(id) {
      const row = db.prepare('SELECT data FROM invoices WHERE id = ?').get(id);
      return row ? JSON.parse(row.data) : null;
    },
    insert(invoice) {
      const saved = { ...invoice, version: 1 };
      db.prepare('INSERT INTO invoices VALUES (?, ?, ?)').run(saved.id, 1, JSON.stringify(saved));
      return saved;
    },
    update(invoice, expectedVersion) {
      const saved = { ...invoice, version: expectedVersion + 1 };
      const result = db.prepare('UPDATE invoices SET version = ?, data = ? WHERE id = ? AND version = ?')
        .run(saved.version, JSON.stringify(saved), saved.id, expectedVersion);
      if (!result.changes) return null;
      return saved;
    },
    close: () => db.close(),
  };
}

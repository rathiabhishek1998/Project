import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'broker')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (phone, role)
);

CREATE TABLE IF NOT EXISTS tractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  hours_used INTEGER,
  expected_price INTEGER,
  location TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tractor_id INTEGER NOT NULL REFERENCES tractors(id) ON DELETE CASCADE,
  filename TEXT NOT NULL UNIQUE,
  angle TEXT -- front, rear, left, ...; NULL for photos uploaded before angles existed
);
`;

export function createDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('photos') WHERE name = 'angle'").get()) {
    db.exec('ALTER TABLE photos ADD COLUMN angle TEXT');
  }
  return db;
}

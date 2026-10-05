import { EMBED_DIMENSIONS } from './ai.js';

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

-- Papers for a tractor (one per type). data is what Claude read from the file, as JSON; see ai.js and verify.js.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tractor_id INTEGER NOT NULL REFERENCES tractors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('rc', 'insurance', 'loan_noc', 'owner_id')),
  filename TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tractor_id, doc_type)
);

-- Searchable pieces of each document's text, with their embeddings (Voyage AI, ${EMBED_DIMENSIONS} dimensions).
-- ID proofs are never stored here.
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tractor_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding F32_BLOB(${EMBED_DIMENSIONS}) NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_chunks_tractor ON doc_chunks (tractor_id);

-- Login sessions (see auth.js). Times are milliseconds since 1970. token_hash is the SHA-256 of the cookie's token.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remember INTEGER NOT NULL,
  idle_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
`;

/**
 * Opens the database and creates the tables if needed.
 * `url` is a Turso database URL (libsql://...), a local file (file:tractors.db) or ":memory:".
 */
export async function createDb({ url = ':memory:', authToken } = {}) {
  // A remote database only needs the HTTP client, which has no native parts to load on a server like Vercel.
  const local = url === ':memory:' || url.startsWith('file:');
  const { createClient } = local ? await import('@libsql/client') : await import('@libsql/client/web');
  const db = createClient({ url, authToken });
  await db.executeMultiple(SCHEMA);
  // Columns added to photos after the first release: its angle, and what Claude sees in it (with its embedding).
  const { rows } = await db.execute("SELECT name FROM pragma_table_info('photos')");
  const columns = new Set(rows.map((r) => r.name));
  const added = { angle: 'TEXT', description: 'TEXT', embedding: `F32_BLOB(${EMBED_DIMENSIONS})` };
  for (const [name, type] of Object.entries(added)) {
    if (!columns.has(name)) await db.execute(`ALTER TABLE photos ADD COLUMN ${name} ${type}`);
  }
  // The result of the one-time photo check (JSON, see app.js checkPhotos); NULL until the photos are checked.
  const { rows: tractorColumns } = await db.execute("SELECT 1 FROM pragma_table_info('tractors') WHERE name = 'photo_check'");
  if (!tractorColumns.length) await db.execute('ALTER TABLE tractors ADD COLUMN photo_check TEXT');
  return db;
}

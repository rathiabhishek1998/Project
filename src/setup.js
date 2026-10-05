// Builds the app from environment variables. Used by `npm start` (src/index.js) and by Vercel (api/index.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAi } from './ai.js';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { blobStorage, diskStorage } from './storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A missing or wrong setting; its message is safe to show and says how to fix it. */
class ConfigError extends Error {
  name = 'ConfigError';
}

export async function buildApp(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const onVercel = Boolean(env.VERCEL);
  const useBlob = Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);

  if (production && !env.JWT_SECRET) throw new ConfigError('Set JWT_SECRET in production');
  // Vercel servers keep no files between requests, so data and photos must live in Turso and Vercel Blob.
  if (onVercel && !env.TURSO_DATABASE_URL) {
    throw new ConfigError('Connect a Turso database (TURSO_DATABASE_URL) in Vercel');
  }
  if (onVercel && !useBlob) throw new ConfigError('Connect a Vercel Blob store (BLOB_READ_WRITE_TOKEN) in Vercel');

  const db = await createDb({
    url: env.TURSO_DATABASE_URL ?? `file:${env.DB_PATH ?? path.join(root, 'tractors.db')}`,
    authToken: env.TURSO_AUTH_TOKEN,
  });
  const storage = useBlob ? blobStorage() : diskStorage(env.UPLOAD_DIR ?? path.join(root, 'uploads'));
  const config = { jwtSecret: env.JWT_SECRET ?? 'dev-only-secret', secureCookies: production };

  // Without these keys the site still works; the assistant and document checks say they are not set up.
  const ai = createAi({ anthropicKey: env.ANTHROPIC_API_KEY, voyageKey: env.VOYAGE_API_KEY });

  return createApp({ db, config, storage, ai });
}

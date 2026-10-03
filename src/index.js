import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDb } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';

if (production && !process.env.JWT_SECRET) throw new Error('Set JWT_SECRET in production');

const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret',
  secureCookies: production,
  uploadDir: process.env.UPLOAD_DIR ?? path.join(root, 'uploads'),
};

const db = createDb(process.env.DB_PATH ?? path.join(root, 'tractors.db'));
createApp({ db, config }).listen(config.port, () => {
  console.log(`Tractor marketplace running at http://localhost:${config.port}`);
});

import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser, COOKIE, requireRole, setAuthCookie } from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_PHOTOS = 8;
const PHONE_RE = /^[6-9]\d{9}$/;

class BadRequest extends Error {}

const toInt = (v) => (v === undefined || v === '' ? null : Number(v));

const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role });

export function createApp({ db, config }) {
  const app = express();
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${IMAGE_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: MAX_PHOTOS },
    fileFilter: (_req, file, cb) =>
      IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new BadRequest('Photos must be JPG, PNG or WEBP')),
  });

  app.use(express.json());
  app.use(attachUser(config.jwtSecret));

  // ---------- Auth (customers and brokers have separate accounts and logins) ----------

  app.post('/api/auth/register', (req, res) => {
    const { name, phone, password, role } = req.body ?? {};
    if (!['customer', 'broker'].includes(role)) throw new BadRequest('Role must be customer or broker');
    if (!name?.trim()) throw new BadRequest('Name is required');
    if (!PHONE_RE.test(phone ?? '')) throw new BadRequest('Enter a valid 10-digit mobile number');
    if (!password || password.length < 6) throw new BadRequest('Password must be at least 6 characters');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND role = ?').get(phone, role)) {
      return res.status(409).json({ error: `A ${role} account with this number already exists` });
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (name, phone, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name.trim(), phone, bcrypt.hashSync(password, 10), role);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    setAuthCookie(res, user, config);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { phone, password, role } = req.body ?? {};
    const user = db.prepare('SELECT * FROM users WHERE phone = ? AND role = ?').get(phone ?? '', role ?? '');
    if (!user || !bcrypt.compareSync(password ?? '', user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect mobile number or password' });
    }
    setAuthCookie(res, user, config);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.status(204).end();
  });

  app.get('/api/auth/me', (req, res) => {
    const user = req.user && db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json({ user: publicUser(user) });
  });

  // ---------- Tractors ----------

  const TRACTOR_SELECT = `
    SELECT t.*, u.name AS customer_name, u.phone AS customer_phone,
      (SELECT json_group_array(filename) FROM (SELECT filename FROM photos p WHERE p.tractor_id = t.id ORDER BY p.id)) AS photo_files
    FROM tractors t JOIN users u ON u.id = t.customer_id`;

  const serialize = (row) => ({
    id: row.id,
    brand: row.brand,
    model: row.model,
    year: row.year,
    hoursUsed: row.hours_used,
    expectedPrice: row.expected_price,
    location: row.location,
    description: row.description,
    createdAt: row.created_at,
    customer: { name: row.customer_name, phone: row.customer_phone },
    photos: JSON.parse(row.photo_files).map((f) => `/uploads/${f}`),
  });

  // Customer posts a tractor with photos (multipart form, field "photos").
  app.post('/api/tractors', requireRole('customer'), upload.array('photos', MAX_PHOTOS), (req, res) => {
    const files = req.files ?? [];
    try {
      const { brand, model, location, description } = req.body;
      const year = toInt(req.body.year);
      const hoursUsed = toInt(req.body.hoursUsed);
      const expectedPrice = toInt(req.body.expectedPrice);
      if (!brand?.trim() || !model?.trim()) throw new BadRequest('Brand and model are required');
      if (!location?.trim()) throw new BadRequest('Location is required');
      if (!Number.isInteger(year) || year < 1970 || year > new Date().getFullYear()) {
        throw new BadRequest('Enter a valid year');
      }
      for (const n of [hoursUsed, expectedPrice]) {
        if (n !== null && (!Number.isInteger(n) || n < 0)) throw new BadRequest('Hours and price must be positive numbers');
      }
      if (!files.length) throw new BadRequest('Add at least one photo of the tractor');

      db.exec('BEGIN');
      const { lastInsertRowid: id } = db
        .prepare(`INSERT INTO tractors (customer_id, brand, model, year, hours_used, expected_price, location, description)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, brand.trim(), model.trim(), year, hoursUsed, expectedPrice, location.trim(), description?.trim() || null);
      const addPhoto = db.prepare('INSERT INTO photos (tractor_id, filename) VALUES (?, ?)');
      for (const f of files) addPhoto.run(id, f.filename);
      db.exec('COMMIT');

      res.status(201).json({ tractor: serialize(db.prepare(`${TRACTOR_SELECT} WHERE t.id = ?`).get(id)) });
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      for (const f of files) fs.rmSync(f.path, { force: true });
      throw err;
    }
  });

  // Customer: their own posts.
  app.get('/api/tractors/mine', requireRole('customer'), (req, res) => {
    const rows = db.prepare(`${TRACTOR_SELECT} WHERE t.customer_id = ? ORDER BY t.id DESC`).all(req.user.id);
    res.json({ tractors: rows.map(serialize) });
  });

  // Broker: every customer post, newest first, with optional text search.
  app.get('/api/tractors', requireRole('broker'), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? db.prepare(`${TRACTOR_SELECT} WHERE t.brand LIKE ?1 OR t.model LIKE ?1 OR t.location LIKE ?1 ORDER BY t.id DESC`)
        .all(`%${q}%`)
      : db.prepare(`${TRACTOR_SELECT} ORDER BY t.id DESC`).all();
    res.json({ tractors: rows.map(serialize) });
  });

  app.delete('/api/tractors/:id', requireRole('customer'), (req, res) => {
    const tractor = db.prepare('SELECT * FROM tractors WHERE id = ?').get(Number(req.params.id));
    if (!tractor) return res.status(404).json({ error: 'Not found' });
    if (tractor.customer_id !== req.user.id) return res.status(403).json({ error: 'Not your post' });
    const files = db.prepare('SELECT filename FROM photos WHERE tractor_id = ?').all(tractor.id);
    db.prepare('DELETE FROM tractors WHERE id = ?').run(tractor.id);
    for (const { filename } of files) fs.rmSync(path.join(config.uploadDir, filename), { force: true });
    res.status(204).end();
  });

  // Photos are only visible to brokers and to the customer who posted them.
  app.get('/uploads/:file', (req, res) => {
    if (!req.user) return res.status(401).end();
    const photo = db
      .prepare('SELECT t.customer_id FROM photos p JOIN tractors t ON t.id = p.tractor_id WHERE p.filename = ?')
      .get(req.params.file);
    if (!photo) return res.status(404).end();
    if (req.user.role !== 'broker' && photo.customer_id !== req.user.id) return res.status(403).end();
    res.sendFile(path.join(config.uploadDir, path.basename(req.params.file)));
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    if (err instanceof BadRequest || err.name === 'MulterError') return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

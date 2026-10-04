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
// Angles a customer can photograph, in display order (the first one present is the cover).
// One photo per angle; each is uploaded in its own multipart field, e.g. "photo_front".
const PHOTO_ANGLES = ['front', 'rear', 'left', 'right', 'engine', 'dashboard', 'tyres', 'other'];
const PHONE_RE = /^[6-9]\d{9}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class BadRequest extends HttpError {
  constructor(message) {
    super(400, message);
  }
}

const toInt = (v) => (v === undefined || v === '' ? null : Number(v));

const angleOrder = (angle) => (PHOTO_ANGLES.includes(angle) ? PHOTO_ANGLES.indexOf(angle) : PHOTO_ANGLES.length);

/** Validates the tractor details from a create/edit form. */
function readDetails(body) {
  const { brand, model, location, description } = body;
  const year = toInt(body.year);
  const hoursUsed = toInt(body.hoursUsed);
  const expectedPrice = toInt(body.expectedPrice);
  if (!brand?.trim() || !model?.trim()) throw new BadRequest('Brand and model are required');
  if (!location?.trim()) throw new BadRequest('Location is required');
  if (!Number.isInteger(year) || year < 1970 || year > new Date().getFullYear()) {
    throw new BadRequest('Enter a valid year');
  }
  for (const n of [hoursUsed, expectedPrice]) {
    if (n !== null && (!Number.isInteger(n) || n < 0)) throw new BadRequest('Hours and price must be positive numbers');
  }
  return {
    brand: brand.trim(), model: model.trim(), year, hoursUsed, expectedPrice,
    location: location.trim(), description: description?.trim() || null,
  };
}

/** The photos multer saved for this request, as [{ angle, file }]. */
const uploadedPhotos = (req) =>
  Object.entries(req.files ?? {}).map(([field, [file]]) => ({ angle: field.slice('photo_'.length), file }));

const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role });

export function createApp({ db, config }) {
  const app = express();
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${IMAGE_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: PHOTO_ANGLES.length },
    fileFilter: (_req, file, cb) =>
      IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new BadRequest('Photos must be JPG, PNG or WEBP')),
  });
  const uploadPhotos = upload.fields(PHOTO_ANGLES.map((angle) => ({ name: `photo_${angle}`, maxCount: 1 })));

  // Wraps an upload handler so a failed request leaves no half-written rows or orphaned files.
  const cleanupOnError = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      for (const { file } of uploadedPhotos(req)) fs.rmSync(file.path, { force: true });
      throw err;
    }
  };

  // Loads the tractor in :id into req.tractor, if it belongs to the logged-in customer.
  const ownTractor = (req, _res, next) => {
    const tractor = db.prepare('SELECT * FROM tractors WHERE id = ?').get(Number(req.params.id));
    if (!tractor) throw new HttpError(404, 'Not found');
    if (tractor.customer_id !== req.user.id) throw new HttpError(403, 'Not your post');
    req.tractor = tractor;
    next();
  };

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
      (SELECT json_group_array(json_object('id', id, 'filename', filename, 'angle', angle))
        FROM (SELECT * FROM photos p WHERE p.tractor_id = t.id ORDER BY p.id)) AS photo_json
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
    photos: JSON.parse(row.photo_json)
      .map((p) => ({ id: p.id, angle: p.angle, url: `/uploads/${p.filename}` }))
      .sort((a, b) => angleOrder(a.angle) - angleOrder(b.angle)),
  });

  const addPhoto = (tractorId, { angle, file }) =>
    db.prepare('INSERT INTO photos (tractor_id, filename, angle) VALUES (?, ?, ?)').run(tractorId, file.filename, angle);

  const getTractor = (id) => serialize(db.prepare(`${TRACTOR_SELECT} WHERE t.id = ?`).get(id));

  // Customer posts a tractor with photos (multipart form, one field per angle: "photo_front", "photo_rear", ...).
  app.post('/api/tractors', requireRole('customer'), uploadPhotos, cleanupOnError((req, res) => {
    const d = readDetails(req.body);
    const photos = uploadedPhotos(req);
    if (!photos.length) throw new BadRequest('Add at least one photo of the tractor');

    db.exec('BEGIN');
    const { lastInsertRowid: id } = db
      .prepare(`INSERT INTO tractors (customer_id, brand, model, year, hours_used, expected_price, location, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, d.brand, d.model, d.year, d.hoursUsed, d.expectedPrice, d.location, d.description);
    for (const p of photos) addPhoto(id, p);
    db.exec('COMMIT');

    res.status(201).json({ tractor: getTractor(id) });
  }));

  // Customer edits their post. Same form as posting; photos are optional here:
  // a photo sent for an angle replaces the one already there, and "removePhotoIds"
  // (comma-separated) deletes photos without replacing them.
  app.put('/api/tractors/:id', requireRole('customer'), ownTractor, uploadPhotos, cleanupOnError((req, res) => {
    const { id } = req.tractor;
    const d = readDetails(req.body);
    const photos = uploadedPhotos(req);
    const removeIds = new Set(String(req.body.removePhotoIds ?? '').split(',').filter(Boolean).map(Number));
    const replacedAngles = new Set(photos.map((p) => p.angle));
    const existing = db.prepare('SELECT * FROM photos WHERE tractor_id = ?').all(id);
    const dropped = existing.filter((p) => removeIds.has(p.id) || replacedAngles.has(p.angle));
    if (existing.length - dropped.length + photos.length === 0) {
      throw new BadRequest('Keep at least one photo of the tractor');
    }

    db.exec('BEGIN');
    db.prepare(`UPDATE tractors SET brand = ?, model = ?, year = ?, hours_used = ?, expected_price = ?, location = ?, description = ?
                WHERE id = ?`)
      .run(d.brand, d.model, d.year, d.hoursUsed, d.expectedPrice, d.location, d.description, id);
    const deletePhoto = db.prepare('DELETE FROM photos WHERE id = ?');
    for (const p of dropped) deletePhoto.run(p.id);
    for (const p of photos) addPhoto(id, p);
    db.exec('COMMIT');

    for (const p of dropped) fs.rmSync(path.join(config.uploadDir, p.filename), { force: true });
    res.json({ tractor: getTractor(id) });
  }));

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

  app.delete('/api/tractors/:id', requireRole('customer'), ownTractor, (req, res) => {
    const { tractor } = req;
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
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.name === 'MulterError') {
      const message = err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Add only one photo for each angle' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

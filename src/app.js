import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiError, documentChunks, LANGUAGES } from './ai.js';
import { createSessions, notLoggedIn, requireRole } from './auth.js';
import { DOC_TYPES, MIN_PHOTOS, PHOTO_LABELS, verifyListing } from './verify.js';

const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const DOCUMENT_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
const MIME_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]));
// One photo per angle; each is uploaded in its own multipart field, e.g. "photo_front".
const PHOTO_ANGLES = Object.keys(PHOTO_LABELS);
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

/** The photos in this request, as [{ angle, filename, file }]; file.buffer holds the image. */
const uploadedPhotos = (req) =>
  Object.entries(req.files ?? {}).map(([field, [file]]) => ({
    angle: field.slice('photo_'.length),
    filename: `${crypto.randomUUID()}${IMAGE_TYPES[file.mimetype]}`,
    file,
  }));

const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role });

/** Checks a chat history sent by the page: alternating user/assistant text turns, ending with the customer. */
function readChat(messages) {
  const ok = Array.isArray(messages) && messages.length > 0 && messages.length <= 40 &&
    messages.every((m, i) => m?.role === (i % 2 ? 'assistant' : 'user') && typeof m.content === 'string' &&
      m.content.trim() && m.content.length <= 2000) &&
    messages.length % 2 === 1;
  if (!ok) throw new BadRequest('Invalid conversation');
  return messages;
}

// Guardrails enforced here, not just asked of the model: an answer it marks off topic, or one far longer than
// its job needs (a sign it was talked into something else), is replaced with these fixed messages.
// Each in the language the person wrote in (one language only, like the assistant's own replies).
const OFF_TOPIC = {
  customer: {
    mr: 'मी फक्त तुमच्या ट्रॅक्टरची माहिती, फोटो आणि कागदपत्रे यासाठी मदत करू शकतो.',
    hi: 'मैं सिर्फ़ आपके ट्रैक्टर की जानकारी, फ़ोटो और कागज़ात में मदद कर सकता हूँ।',
    en: 'I can only help with listing your tractor, its photos and papers.',
  },
  broker: {
    mr: 'मी फक्त या ट्रॅक्टरच्या कागदपत्रांबद्दल आणि फोटोंबद्दल प्रश्नांची उत्तरे देऊ शकतो.',
    hi: 'मैं सिर्फ़ इस ट्रैक्टर के कागज़ात और फ़ोटो के बारे में सवालों के जवाब दे सकता हूँ।',
    en: "I can only answer questions about this tractor's papers and photos.",
  },
};
/** The language to answer in: the one the model found, else Devanagari text counts as Marathi. */
const replyLanguage = (language, text) => (LANGUAGES.includes(language) ? language : /[\u0900-\u097F]/.test(text) ? 'mr' : 'en');
const MAX_REPLY = 1200;
const withinLimit = (text, max) => typeof text === 'string' && text.trim().length > 0 && text.length <= max;

/** Keeps only form values of the right type from the assistant's answer. */
function cleanFields(fields) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    brand: text(fields.brand), model: text(fields.model), year: int(fields.year), hoursUsed: int(fields.hoursUsed),
    expectedPrice: int(fields.expectedPrice), location: text(fields.location), description: text(fields.description),
  };
}

/**
 * db: a libsql client (see db.js). storage: where photos and documents live (see storage.js).
 * ai: the AI calls (see ai.js).
 */
export function createApp({ db, config, storage, ai }) {
  const app = express();

  const one = async (sql, ...args) => (await db.execute({ sql, args })).rows[0];
  const all = async (sql, ...args) => (await db.execute({ sql, args })).rows;

  // Photos are held in memory until validated, then written to storage.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: PHOTO_ANGLES.length },
    fileFilter: (_req, file, cb) =>
      IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new BadRequest('Photos must be JPG, PNG or WEBP')),
  });
  const uploadPhotos = upload.fields(PHOTO_ANGLES.map((angle) => ({ name: `photo_${angle}`, maxCount: 1 })));
  const uploadDocument = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) =>
      DOCUMENT_TYPES[file.mimetype] ? cb(null, true) : cb(new BadRequest('Documents must be a JPG, PNG, WEBP photo or a PDF')),
  }).single('file');

  const removeQuietly = (filenames) =>
    storage.remove(filenames).catch((err) => console.error('Could not remove photos', filenames, err));

  // Saves the files, then runs the database writes. If anything fails, the saved files are removed again.
  async function saveFilesThen(files, writeDb) {
    const saves = await Promise.allSettled(files.map((f) => storage.save(f.filename, f.file.buffer, f.file.mimetype)));
    try {
      const failed = saves.find((s) => s.status === 'rejected');
      if (failed) throw failed.reason;
      return await writeDb();
    } catch (err) {
      await removeQuietly(files.map((f) => f.filename));
      throw err;
    }
  }

  // The photo check, run once each time the listing is posted or saved: Claude looks at all of its photos
  // together, compares them with the form (see verify.js) and describes each one. The result is kept on the
  // tractor, and each description is stored with its embedding so brokers' questions can be answered from the photos.
  async function checkPhotos(tractorId) {
    const tractor = await one(
      'SELECT brand, model, year, hours_used AS hoursUsed, description FROM tractors WHERE id = ?', tractorId,
    );
    const photos = (await all('SELECT id, filename, angle FROM photos WHERE tractor_id = ?', tractorId))
      .sort((a, b) => angleOrder(a.angle) - angleOrder(b.angle));
    if (photos.length < MIN_PHOTOS) return;
    const files = await Promise.all(photos.map(async (p) => ({
      buffer: await storage.read(p.filename),
      mimetype: MIME_TYPES[path.extname(p.filename)],
      label: PHOTO_LABELS[p.angle] ?? 'Photo',
    })));
    const result = await ai.checkPhotos(files, tractor);
    const descriptions = photos.map((_, i) => `Photo (${files[i].label}): ${result.photos[i].description}`);
    const embeddings = await ai.embed(descriptions, 'document');
    const check = {
      photos: photos.map((p, i) => {
        const { shows_tractor, matches_angle, from_internet } = result.photos[i];
        return { angle: p.angle, shows_tractor, matches_angle, from_internet };
      }),
      same_tractor: result.same_tractor,
      matches_listing: result.matches_listing,
      hour_meter_reading: result.hour_meter_reading,
      contradictions: result.contradictions,
      checkedAt: new Date().toISOString(),
    };
    await db.batch([
      ...photos.map((p, i) => ({
        sql: 'UPDATE photos SET description = ?, embedding = vector32(?) WHERE id = ?',
        args: [descriptions[i], JSON.stringify(embeddings[i]), p.id],
      })),
      { sql: 'UPDATE tractors SET photo_check = ? WHERE id = ?', args: [JSON.stringify(check), tractorId] },
    ], 'write');
  }

  // Loads the tractor in :id into req.tractor, if it belongs to the logged-in customer.
  const ownTractor = async (req, _res, next) => {
    const tractor = await one('SELECT * FROM tractors WHERE id = ?', Number(req.params.id));
    if (!tractor) throw new HttpError(404, 'Not found');
    if (tractor.customer_id !== req.user.id) throw new HttpError(403, 'Not your post');
    req.tractor = tractor;
    next();
  };

  const sessions = createSessions(db, config);

  app.use(express.json());
  app.use(sessions.attach);

  // ---------- Auth (customers and brokers have separate accounts and logins) ----------

  app.post('/api/auth/register', async (req, res) => {
    const { name, phone, password, role } = req.body ?? {};
    if (!['customer', 'broker'].includes(role)) throw new BadRequest('Role must be customer or broker');
    if (!name?.trim()) throw new BadRequest('Name is required');
    if (!PHONE_RE.test(phone ?? '')) throw new BadRequest('Enter a valid 10-digit mobile number');
    if (!password || password.length < 6) throw new BadRequest('Password must be at least 6 characters');
    if (await one('SELECT 1 FROM users WHERE phone = ? AND role = ?', phone, role)) {
      return res.status(409).json({ error: `A ${role} account with this number already exists` });
    }
    const user = await one(
      'INSERT INTO users (name, phone, password_hash, role) VALUES (?, ?, ?, ?) RETURNING *',
      name.trim(), phone, await bcrypt.hash(password, 10), role,
    );
    await sessions.start(req, res, user, req.body.remember === true);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { phone, password, role, remember } = req.body ?? {};
    const user = await one('SELECT * FROM users WHERE phone = ? AND role = ?', phone ?? '', role ?? '');
    if (!user || !(await bcrypt.compare(password ?? '', user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect mobile number or password' });
    }
    await sessions.start(req, res, user, remember === true);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    await sessions.end(req, res);
    res.status(204).end();
  });

  // The logged-in user, and how long their session may sit idle (the page logs out after that).
  app.get('/api/auth/me', async (req, res) => {
    const user = req.user && (await one('SELECT * FROM users WHERE id = ?', req.user.id));
    if (!user) return notLoggedIn(req, res);
    res.json({ user: publicUser(user), session: { remember: req.session.remember, idleMs: req.session.idleMs } });
  });

  // The devices the user is logged in on.
  app.get('/api/auth/sessions', async (req, res) => {
    if (!req.user) return notLoggedIn(req, res);
    const rows = await all(
      // This device first, then the most recently used.
      'SELECT id, device, remember, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY id = ? DESC, last_seen_at DESC',
      req.user.id, req.session.id,
    );
    res.json({
      sessions: rows.map((s) => ({
        id: s.id, device: s.device, remember: Boolean(s.remember), createdAt: s.created_at, lastSeenAt: s.last_seen_at,
        current: s.id === req.session.id,
      })),
    });
  });

  // Log out one device.
  app.delete('/api/auth/sessions/:id', async (req, res) => {
    if (!req.user) return notLoggedIn(req, res);
    const { rowsAffected } = await db.execute({
      sql: 'DELETE FROM sessions WHERE id = ? AND user_id = ?', args: [Number(req.params.id), req.user.id],
    });
    if (!rowsAffected) throw new HttpError(404, 'Not found');
    if (Number(req.params.id) === req.session.id) await sessions.end(req, res);
    res.status(204).end();
  });

  // Log out every device except this one.
  app.delete('/api/auth/sessions', async (req, res) => {
    if (!req.user) return notLoggedIn(req, res);
    const { rowsAffected } = await db.execute({
      sql: 'DELETE FROM sessions WHERE user_id = ? AND id != ?', args: [req.user.id, req.session.id],
    });
    res.json({ ended: rowsAffected });
  });

  // ---------- Tractors ----------

  const TRACTOR_SELECT = `
    SELECT t.*, u.name AS customer_name, u.phone AS customer_phone,
      (SELECT json_group_array(json_object('id', id, 'filename', filename, 'angle', angle))
        FROM (SELECT * FROM photos p WHERE p.tractor_id = t.id ORDER BY p.id)) AS photo_json,
      (SELECT json_group_array(json_object('type', doc_type, 'data', json(data), 'createdAt', created_at))
        FROM documents d WHERE d.tractor_id = t.id) AS document_json
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
    // Worked out on every read, so editing the listing (e.g. its year) re-checks the documents.
    verification: verifyListing(row, JSON.parse(row.document_json), {
      count: JSON.parse(row.photo_json).length,
      check: row.photo_check ? JSON.parse(row.photo_check) : null,
    }),
  });

  const getTractor = async (id) => serialize(await one(`${TRACTOR_SELECT} WHERE t.id = ?`, id));

  // Posting (and saving an edit) is three steps, run one after another by the page, each its own request
  // (one request can't carry all the photos and papers): this one checks the form and saves it with the photos,
  // then the page runs the photo check (/photos/check) and uploads each paper (/documents/:type).

  // Customer posts a tractor with photos (multipart form, one field per angle: "photo_front", "photo_rear", ...).
  app.post('/api/tractors', requireRole('customer'), uploadPhotos, async (req, res) => {
    const d = readDetails(req.body);
    const photos = uploadedPhotos(req);
    if (photos.length < MIN_PHOTOS) throw new BadRequest(`Add at least ${MIN_PHOTOS} photos of the tractor`);

    const [{ lastInsertRowid }] = await saveFilesThen(photos, () => db.batch([
      {
        sql: `INSERT INTO tractors (customer_id, brand, model, year, hours_used, expected_price, location, description)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [req.user.id, d.brand, d.model, d.year, d.hoursUsed, d.expectedPrice, d.location, d.description],
      },
      // The batch is one write transaction, so this customer's newest tractor is the one just inserted.
      ...photos.map((p) => ({
        sql: 'INSERT INTO photos (tractor_id, filename, angle) SELECT max(id), ?, ? FROM tractors WHERE customer_id = ?',
        args: [p.filename, p.angle, req.user.id],
      })),
    ], 'write'));

    res.status(201).json({ tractor: await getTractor(Number(lastInsertRowid)) });
  });

  // Customer edits their post. Same form as posting; photos are optional here:
  // a photo sent for an angle replaces the one already there, and "removePhotoIds"
  // (comma-separated) deletes photos without replacing them.
  app.put('/api/tractors/:id', requireRole('customer'), ownTractor, uploadPhotos, async (req, res) => {
    const { id } = req.tractor;
    const d = readDetails(req.body);
    const photos = uploadedPhotos(req);
    const removeIds = new Set(String(req.body.removePhotoIds ?? '').split(',').filter(Boolean).map(Number));
    const replacedAngles = new Set(photos.map((p) => p.angle));
    const existing = await all('SELECT * FROM photos WHERE tractor_id = ?', id);
    const dropped = existing.filter((p) => removeIds.has(p.id) || replacedAngles.has(p.angle));
    if (existing.length - dropped.length + photos.length < MIN_PHOTOS) {
      throw new BadRequest(`Keep at least ${MIN_PHOTOS} photos of the tractor`);
    }
    // Every saved edit is checked again, like a new post: the old photo check no longer counts.
    await saveFilesThen(photos, () => db.batch([
      {
        sql: `UPDATE tractors SET brand = ?, model = ?, year = ?, hours_used = ?, expected_price = ?, location = ?, description = ?,
                photo_check = NULL
              WHERE id = ?`,
        args: [d.brand, d.model, d.year, d.hoursUsed, d.expectedPrice, d.location, d.description, id],
      },
      ...dropped.map((p) => ({ sql: 'DELETE FROM photos WHERE id = ?', args: [p.id] })),
      ...photos.map((p) => ({ sql: 'INSERT INTO photos (tractor_id, filename, angle) VALUES (?, ?, ?)', args: [id, p.filename, p.angle] })),
    ], 'write'));

    await removeQuietly(dropped.map((p) => p.filename));
    res.json({ tractor: await getTractor(id) });
  });

  // Customer: their own posts.
  app.get('/api/tractors/mine', requireRole('customer'), async (req, res) => {
    const rows = await all(`${TRACTOR_SELECT} WHERE t.customer_id = ? ORDER BY t.id DESC`, req.user.id);
    res.json({ tractors: rows.map(serialize) });
  });

  // Broker: every complete customer post (all documents verified), newest first, with optional text search.
  app.get('/api/tractors', requireRole('broker'), async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? await all(`${TRACTOR_SELECT} WHERE t.brand LIKE ?1 OR t.model LIKE ?1 OR t.location LIKE ?1 ORDER BY t.id DESC`, `%${q}%`)
      : await all(`${TRACTOR_SELECT} ORDER BY t.id DESC`);
    res.json({ tractors: rows.map(serialize).filter((t) => t.verification.complete) });
  });

  app.delete('/api/tractors/:id', requireRole('customer'), ownTractor, async (req, res) => {
    const { id } = req.tractor;
    const files = await all(
      'SELECT filename FROM photos WHERE tractor_id = ?1 UNION ALL SELECT filename FROM documents WHERE tractor_id = ?1', id,
    );
    await db.batch([
      { sql: 'DELETE FROM doc_chunks WHERE tractor_id = ?', args: [id] },
      { sql: 'DELETE FROM documents WHERE tractor_id = ?', args: [id] },
      { sql: 'DELETE FROM photos WHERE tractor_id = ?', args: [id] },
      { sql: 'DELETE FROM tractors WHERE id = ?', args: [id] },
    ], 'write');
    await removeQuietly(files.map((f) => f.filename));
    res.status(204).end();
  });

  // ---------- AI assistant and documents ----------

  // Customer chats (in Marathi, Hindi or English) and the assistant fills the listing form in English.
  app.post('/api/assistant/form', requireRole('customer'), async (req, res) => {
    const messages = readChat(req.body?.messages);
    const form = cleanFields(req.body?.form ?? {});
    const { language, onTopic, reply, fields } = await ai.fillForm(messages, form);
    // Off-topic turns can't change the form, and get a fixed reply rather than whatever the model wrote.
    if (!onTopic || !withinLimit(reply, MAX_REPLY)) {
      const lang = replyLanguage(language, messages.at(-1).content);
      return res.json({ reply: OFF_TOPIC.customer[lang], fields: form, offTopic: true, language: lang });
    }
    res.json({ reply, fields: cleanFields(fields), language: replyLanguage(language, reply) });
  });

  // Step 2 of posting or saving: the photo check. If it fails (e.g. the AI is unavailable) the listing is still
  // saved, its photos show as not checked yet, and the customer can run this again from the listing.
  app.post('/api/tractors/:id/photos/check', requireRole('customer'), ownTractor, async (req, res) => {
    const { id } = req.tractor;
    const { n } = await one('SELECT COUNT(*) AS n FROM photos WHERE tractor_id = ?', id);
    if (n < MIN_PHOTOS) throw new BadRequest(`Add at least ${MIN_PHOTOS} photos first (Edit listing)`);
    await checkPhotos(id);
    res.json({ tractor: await getTractor(id) });
  });

  const docType = (req) => {
    if (!DOC_TYPES[req.params.type]) throw new HttpError(404, 'Unknown document type');
    return req.params.type;
  };

  // Customer uploads one document for their tractor. Claude reads it, then the listing's documents are re-checked.
  // The text of RC, insurance and NOC documents is split into chunks and embedded so it can be searched.
  app.put('/api/tractors/:id/documents/:type', requireRole('customer'), ownTractor, uploadDocument, async (req, res) => {
    const type = docType(req);
    if (!req.file) throw new BadRequest('Choose a photo or PDF of the document');
    const { id } = req.tractor;
    const data = await ai.readDocument(type, req.file.buffer, req.file.mimetype);
    if (type === 'owner_id') data.text = ''; // never keep the text of an ID proof
    const chunks = type === 'owner_id' || data.document_type !== type ? [] : documentChunks(type, data);
    const embeddings = chunks.length ? await ai.embed(chunks, 'document') : [];

    const filename = `${crypto.randomUUID()}${DOCUMENT_TYPES[req.file.mimetype]}`;
    const old = await one('SELECT id, filename FROM documents WHERE tractor_id = ? AND doc_type = ?', id, type);
    await saveFilesThen([{ filename, file: req.file }], () => db.batch([
      ...(old ? [
        { sql: 'DELETE FROM doc_chunks WHERE document_id = ?', args: [old.id] },
        { sql: 'DELETE FROM documents WHERE id = ?', args: [old.id] },
      ] : []),
      {
        sql: 'INSERT INTO documents (tractor_id, doc_type, filename, data) VALUES (?, ?, ?, ?)',
        args: [id, type, filename, JSON.stringify(data)],
      },
      ...chunks.map((content, i) => ({
        sql: `INSERT INTO doc_chunks (document_id, tractor_id, content, embedding)
              SELECT id, ?, ?, vector32(?) FROM documents WHERE tractor_id = ? AND doc_type = ?`,
        args: [id, content, JSON.stringify(embeddings[i]), id, type],
      })),
    ], 'write'));
    if (old) await removeQuietly([old.filename]);
    res.json({ tractor: await getTractor(id) });
  });

  // A broker (or the owner) asks a question about a tractor's papers; answered from the closest document chunks.
  app.post('/api/tractors/:id/ask', async (req, res) => {
    if (!req.user) return notLoggedIn(req, res);
    const tractor = await one('SELECT customer_id FROM tractors WHERE id = ?', Number(req.params.id));
    if (!tractor) throw new HttpError(404, 'Not found');
    if (req.user.role !== 'broker' && tractor.customer_id !== req.user.id) throw new HttpError(403, 'Not your post');
    const question = String(req.body?.question ?? '').trim();
    if (!question || question.length > 500) throw new BadRequest('Ask a question of up to 500 characters');

    const id = Number(req.params.id);
    const [embedding] = await ai.embed([question], 'query');
    // The closest pieces of the papers and the photo descriptions, together.
    const chunks = await all(
      `SELECT content FROM (
         SELECT content, vector_distance_cos(embedding, vector32(?2)) AS distance FROM doc_chunks WHERE tractor_id = ?1
         UNION ALL
         SELECT description, vector_distance_cos(embedding, vector32(?2)) FROM photos WHERE tractor_id = ?1 AND embedding IS NOT NULL
       ) ORDER BY distance LIMIT 6`,
      id, JSON.stringify(embedding),
    );
    if (!chunks.length) return res.json({ answer: 'Nothing has been added for this tractor that I can answer from yet.' });
    const { language, onTopic, answer } = await ai.answer(question, chunks.map((c) => c.content));
    if (!onTopic || !withinLimit(answer, MAX_REPLY)) {
      return res.json({ answer: OFF_TOPIC.broker[replyLanguage(language, question)], offTopic: true });
    }
    res.json({ answer });
  });

  // Photos are visible to brokers and to the customer who posted them; documents only to that customer.
  app.get('/uploads/:file', async (req, res) => {
    if (!req.user) return res.status(401).end();
    const file = await one(
      `SELECT t.customer_id, 1 AS brokers_may_see FROM photos p JOIN tractors t ON t.id = p.tractor_id WHERE p.filename = ?1
       UNION ALL
       SELECT t.customer_id, 0 FROM documents d JOIN tractors t ON t.id = d.tractor_id WHERE d.filename = ?1`,
      req.params.file,
    );
    if (!file) return res.status(404).end();
    const broker = req.user.role === 'broker' && file.brokers_may_see;
    if (!broker && file.customer_id !== req.user.id) return res.status(403).end();
    await storage.send(res, req.params.file);
  });

  // Locally the app serves the built React app (npm run build) too; on Vercel it is served as static files.
  // Every other page path gets index.html, and React picks the page from the URL.
  app.use(express.static(CLIENT_DIR));
  app.get('/{*page}', (req, res, next) =>
    req.path.startsWith('/api/') ? next() : res.sendFile(path.join(CLIENT_DIR, 'index.html'), (err) => err && next()));

  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError || err instanceof AiError) return res.status(err.status).json({ error: err.message });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { diskStorage } from '../src/storage.js';
import { AiError, EMBED_DIMENSIONS } from '../src/ai.js';

// Smallest valid PNG (1x1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Stands in for Claude and Voyage. A test "document" is JSON of what Claude would read from it;
// embeddings are word counts hashed into the vector, so texts sharing words come out close.
const fakeAi = {
  calls: [],
  async fillForm(messages, form) {
    this.calls.push({ messages, form });
    const last = messages.at(-1).content;
    const fields = { ...form, brand: 'Mahindra', model: '575 DI', year: 'soon', location: 'Baramati' };
    // "cricket" plays a model that flags itself off topic; "poem" one talked into a long off-topic answer.
    if (last.includes('cricket')) return { onTopic: false, reply: 'Cricket scores are…', fields };
    if (last.includes('poem')) return { onTopic: true, reply: 'Roses are red. '.repeat(200), fields };
    return { onTopic: true, reply: 'तुमचा ट्रॅक्टर कोणत्या वर्षाचा आहे?', fields };
  },
  photosDown: false, // set to make the photo check fail, as when the AI is unavailable
  photoChecks: 0,
  // Photos of a red Mahindra with worn rear tyres and 2500 hours on the meter (the default form says 2500 hours).
  async checkPhotos(photos, listing) {
    if (this.photosDown) throw new AiError(503, 'The assistant is busy. Please try again in a minute');
    this.photoChecks++;
    for (const p of photos) {
      assert.equal(p.mimetype, 'image/png');
      assert.ok(p.buffer.length > 0);
    }
    return {
      photos: photos.map((p) => ({
        shows_tractor: true, matches_angle: true, from_internet: false,
        description: `Red tractor, ${p.label.toLowerCase()} view. Rear tyres worn smooth.`,
      })),
      same_tractor: true,
      matches_listing: listing.brand !== 'Swaraj',
      hour_meter_reading: 2500,
      contradictions: listing.description?.includes('new tyres') ? ['The description says new tyres, but the rear tyres look worn'] : [],
    };
  },
  async readDocument(_type, buffer) {
    return { readable: true, signs_of_tampering: [], text: '', ...JSON.parse(buffer) };
  },
  async answer(question, excerpts) {
    if (question.includes('weather')) return { onTopic: false, answer: 'Sunny tomorrow.' };
    return { onTopic: true, answer: `${question} -> ${excerpts[0]}` };
  },
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(EMBED_DIMENSIONS).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % EMBED_DIMENSIONS, 7)] += 1;
      v[0] += 0.01; // never all zeros
      return v;
    });
  },
};

async function setup() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-test-'));
  const app = createApp({
    db: await createDb(),
    config: { jwtSecret: 'test', secureCookies: false },
    storage: diskStorage(uploadDir),
    ai: fakeAi,
  });
  return { app, uploadDir };
}

// Documents that agree with each other and with the default tractor (Mahindra, 2019).
const GOOD_DOCS = {
  rc: { document_type: 'rc', owner_name: 'Ramesh Patil', registration_number: 'MH 42 AB 1234', chassis_number: 'CH123', make: 'Mahindra & Mahindra', manufacture_year: 2019, financier: null, text: 'Registration certificate. Fuel diesel. Colour red.' },
  insurance: { document_type: 'insurance', owner_name: 'Ramesh Patil', registration_number: 'MH42AB1234', insurer: 'New India Assurance', valid_until: '2099-03-31', text: 'Policy covers third party liability. Insurer New India Assurance.' },
  owner_id: { document_type: 'owner_id', owner_name: 'R. Patil', id_type: 'aadhaar', id_last4: '4321', text: 'should not be kept' },
};

const uploadDoc = (agent, id, type, data) =>
  agent.put(`/api/tractors/${id}/documents/${type}`).attach('file', Buffer.from(JSON.stringify(data)), { filename: 'doc.png', contentType: 'image/png' });

const checkPhotos = (agent, id) => agent.post(`/api/tractors/${id}/photos/check`).expect(200);

async function addGoodDocs(agent, id) {
  for (const [type, data] of Object.entries(GOOD_DOCS)) await uploadDoc(agent, id, type, data).expect(200);
}

async function signup(app, role, phone) {
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send({ name: `Test ${role}`, phone, password: 'secret123', role }).expect(201);
  return agent;
}

const ANGLES = ['front', 'rear', 'left', 'right', 'engine', 'dashboard', 'tyres', 'other'];

const tractorForm = (req, fields, angles) => {
  const all = { brand: 'Mahindra', model: '575 DI', year: '2019', hoursUsed: '2500', expectedPrice: '550000', location: 'Ludhiana', ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, v);
  for (const angle of angles) req.attach(`photo_${angle}`, PNG, `${angle}.png`);
  return req;
};

/** Posts a tractor with `photos` photos (one per angle, in angle order) or the given list of angles. */
const postTractor = (agent, fields = {}, photos = 4) =>
  tractorForm(agent.post('/api/tractors'), fields, Array.isArray(photos) ? photos : ANGLES.slice(0, photos));

const editTractor = (agent, id, fields = {}, angles = []) => tractorForm(agent.put(`/api/tractors/${id}`), fields, angles);

test('customer and broker logins are separate', async () => {
  const { app } = await setup();
  await signup(app, 'customer', '9876543210');
  await request(app).post('/api/auth/login').send({ phone: '9876543210', password: 'secret123', role: 'broker' }).expect(401);
  const ok = await request(app).post('/api/auth/login').send({ phone: '9876543210', password: 'secret123', role: 'customer' }).expect(200);
  assert.equal(ok.body.user.role, 'customer');
  await request(app).post('/api/auth/login').send({ phone: '9876543210', password: 'wrong', role: 'customer' }).expect(401);

  // Same number may hold a separate broker account.
  await signup(app, 'broker', '9876543210');
  await request(app).post('/api/auth/register').send({ name: 'x', phone: '9876543210', password: 'secret123', role: 'broker' }).expect(409);
});

test('register validates input', async () => {
  const { app } = await setup();
  const base = { name: 'A', phone: '9876543210', password: 'secret123', role: 'customer' };
  await request(app).post('/api/auth/register').send({ ...base, phone: '123' }).expect(400);
  await request(app).post('/api/auth/register').send({ ...base, password: '1' }).expect(400);
  await request(app).post('/api/auth/register').send({ ...base, role: 'admin' }).expect(400);
});

test('customer posts a tractor with photos; broker sees it with photos and contact', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const broker = await signup(app, 'broker', '9123456789');

  const created = await postTractor(customer, {}, ['engine', 'rear', 'left', 'front']).expect(201);
  // Photos come back in angle order, front first (it is the cover).
  assert.deepEqual(created.body.tractor.photos.map((p) => p.angle), ['front', 'rear', 'left', 'engine']);
  assert.equal(created.body.tractor.verification.photos.status, 'pending'); // until the page runs the check

  const mine = await customer.get('/api/tractors/mine').expect(200);
  assert.equal(mine.body.tractors.length, 1);

  // Brokers only see it once its documents are verified.
  assert.equal((await broker.get('/api/tractors').expect(200)).body.tractors.length, 0);
  await checkPhotos(customer, created.body.tractor.id);
  await addGoodDocs(customer, created.body.tractor.id);

  const all = await broker.get('/api/tractors').expect(200);
  assert.equal(all.body.tractors.length, 1);
  const t = all.body.tractors[0];
  assert.equal(t.customer.phone, '9876543210');
  assert.equal(t.expectedPrice, 550000);

  const photo = await broker.get(t.photos[0].url).expect(200);
  assert.equal(photo.headers['content-type'], 'image/png');
  await customer.get(t.photos[0].url).expect(200);

  const search = await broker.get('/api/tractors?q=ludh').expect(200);
  assert.equal(search.body.tractors.length, 1);
  const none = await broker.get('/api/tractors?q=swaraj').expect(200);
  assert.equal(none.body.tractors.length, 0);
});

test('access rules for listings and photos', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const other = await signup(app, 'customer', '9876543211');
  const broker = await signup(app, 'broker', '9123456789');
  const { body } = await postTractor(customer).expect(201);
  const photoUrl = body.tractor.photos[0].url;

  await request(app).get('/api/tractors').expect(401);
  await customer.get('/api/tractors').expect(403); // customers can't browse everyone's posts
  await postTractor(broker).expect(403); // brokers don't post
  await request(app).get(photoUrl).expect(401);
  await other.get(photoUrl).expect(403);
  await other.delete(`/api/tractors/${body.tractor.id}`).expect(403);
  await editTractor(other, body.tractor.id, { brand: 'Hacked' }).expect(403);
  await editTractor(broker, body.tractor.id, { brand: 'Hacked' }).expect(403);
  await editTractor(customer, 9999).expect(404);
  const mine = await customer.get('/api/tractors/mine').expect(200);
  assert.equal(mine.body.tractors[0].brand, 'Mahindra');
});

test('customer edits details and replaces or removes photos per angle', async () => {
  const { app, uploadDir } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer, {}, ['front', 'rear', 'left', 'tyres']).expect(201);
  const { id, photos } = body.tractor;
  const [front, rear, left] = photos;

  const edited = await editTractor(customer, id, { brand: 'Swaraj', expectedPrice: '480000', description: 'New tyres' }, ['front', 'right'])
    .field('removePhotoIds', String(rear.id))
    .expect(200);
  const t = edited.body.tractor;
  assert.equal(t.brand, 'Swaraj');
  assert.equal(t.expectedPrice, 480000);
  assert.equal(t.description, 'New tyres');
  assert.deepEqual(t.photos.map((p) => p.angle), ['front', 'left', 'right', 'tyres']);
  assert.notEqual(t.photos[0].id, front.id); // front was replaced
  assert.equal(t.photos[1].id, left.id); // left untouched

  // Replaced and removed photos are gone from disk and no longer served.
  assert.equal(fs.readdirSync(uploadDir).length, 4);
  await customer.get(front.url).expect(404);
  await customer.get(rear.url).expect(404);

  // Editing details alone keeps the photos.
  const again = await editTractor(customer, id, { model: '744 FE' }).expect(200);
  assert.equal(again.body.tractor.photos.length, 4);
});

test('edit validates input, keeps at least 4 photos, and cleans up files on failure', async () => {
  const { app, uploadDir } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer).expect(201);
  const { id, photos } = body.tractor;
  const allIds = photos.map((p) => p.id).join(',');

  let res = await editTractor(customer, id).field('removePhotoIds', allIds).expect(400);
  assert.match(res.body.error, /at least 4 photos/);
  res = await editTractor(customer, id).field('removePhotoIds', String(photos[0].id)).expect(400); // would leave 3
  assert.match(res.body.error, /at least 4 photos/);
  await editTractor(customer, id, { year: '1800' }, ['engine']).expect(400);
  assert.equal(fs.readdirSync(uploadDir).length, 4);

  // Removing every old photo is fine when enough new ones are added in the same edit.
  const fresh = ['engine', 'dashboard', 'tyres', 'other'];
  const ok = await editTractor(customer, id, {}, fresh).field('removePhotoIds', allIds).expect(200);
  assert.deepEqual(ok.body.tractor.photos.map((p) => p.angle), fresh);
  assert.equal(fs.readdirSync(uploadDir).length, 4);
});

test('post requires photos and valid fields, and cleans up files on failure', async () => {
  const { app, uploadDir } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  await postTractor(customer, {}, 0).expect(400);
  const res = await postTractor(customer, {}, 3).expect(400);
  assert.match(res.body.error, /at least 4 photos/);
  await postTractor(customer, { year: '1800' }).expect(400);
  await customer.post('/api/tractors').field('brand', 'X').field('model', 'Y').field('year', '2019').field('location', 'Z')
    .attach('photo_front', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' })
    .expect(400);
  await postTractor(customer, {}, ['front', 'front']).expect(400); // two photos for one angle
  await postTractor(customer, {}, ['roof']).expect(400); // unknown angle
  assert.deepEqual(fs.readdirSync(uploadDir), []);
});

test('deleting a post removes its photos', async () => {
  const { app, uploadDir } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer).expect(201);
  assert.equal(fs.readdirSync(uploadDir).length, 4);
  await customer.delete(`/api/tractors/${body.tractor.id}`).expect(204);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  await customer.get(body.tractor.photos[0].url).expect(404);
});

test('documents are checked against each other and the listing', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer).expect(201);
  const id = body.tractor.id;
  const status = (t) => Object.fromEntries(Object.entries(t.verification.documents).map(([k, v]) => [k, v.status]));

  assert.deepEqual(status(body.tractor), { rc: 'missing', insurance: 'missing', loan_noc: 'missing', owner_id: 'missing' });

  // An RC with no loan makes the NOC unnecessary.
  let res = await uploadDoc(customer, id, 'rc', GOOD_DOCS.rc).expect(200);
  assert.equal(res.body.tractor.verification.documents.loan_noc.status, 'not_required');

  // Mismatches are reported, and the listing stays incomplete.
  res = await uploadDoc(customer, id, 'insurance', { ...GOOD_DOCS.insurance, registration_number: 'MH12ZZ9999', valid_until: '2020-01-01' }).expect(200);
  const { issues } = res.body.tractor.verification.documents.insurance;
  assert.equal(issues.length, 2);
  assert.match(issues.join(' '), /different vehicle.*expired on 2020-01-01/);
  res = await uploadDoc(customer, id, 'owner_id', { ...GOOD_DOCS.owner_id, owner_name: 'Suresh Jadhav' }).expect(200);
  assert.match(res.body.tractor.verification.documents.owner_id.issues[0], /does not match the RC owner/);
  res = await uploadDoc(customer, id, 'rc', { ...GOOD_DOCS.insurance }).expect(200); // insurance uploaded as the RC
  assert.match(res.body.tractor.verification.documents.rc.issues[0], /looks like the Insurance\. Upload the RC book here/);
  assert.equal(res.body.tractor.verification.complete, false);

  // Fixing them (with the photos checked) completes the listing; a loan on the RC then needs a NOC.
  await checkPhotos(customer, id);
  await addGoodDocs(customer, id);
  res = await customer.get('/api/tractors/mine').expect(200);
  assert.equal(res.body.tractors[0].verification.complete, true);
  res = await uploadDoc(customer, id, 'rc', { ...GOOD_DOCS.rc, financier: 'SBI' }).expect(200);
  assert.equal(res.body.tractor.verification.documents.loan_noc.status, 'missing');
  res = await uploadDoc(customer, id, 'loan_noc', { document_type: 'loan_noc', chassis_number: 'ch-123', financier: 'SBI' }).expect(200);
  assert.equal(res.body.tractor.verification.complete, true);

  // Editing the listing re-checks it: the RC says 2019.
  res = await editTractor(customer, id, { year: '2015' }).expect(200);
  assert.match(res.body.tractor.verification.documents.rc.issues[0], /made in 2019/);

});

test('document access rules, storage and cleanup', async () => {
  const { app, uploadDir } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const other = await signup(app, 'customer', '9876543211');
  const broker = await signup(app, 'broker', '9123456789');
  const { body } = await postTractor(customer).expect(201);
  const id = body.tractor.id;

  await uploadDoc(other, id, 'rc', GOOD_DOCS.rc).expect(403);
  await uploadDoc(broker, id, 'rc', GOOD_DOCS.rc).expect(403);
  await uploadDoc(customer, id, 'passport', GOOD_DOCS.rc).expect(404);
  await customer.put(`/api/tractors/${id}/documents/rc`)
    .attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' }).expect(400);
  await addGoodDocs(customer, id);
  await uploadDoc(customer, id, 'rc', GOOD_DOCS.rc).expect(200); // replacing keeps one file per type
  assert.equal(fs.readdirSync(uploadDir).length, 4 + 3);

  // Document files are for the owner only, even for brokers.
  const photoFiles = body.tractor.photos.map((p) => p.url.split('/').pop());
  const [file] = fs.readdirSync(uploadDir).filter((f) => !photoFiles.includes(f));
  await customer.get(`/uploads/${file}`).expect(200);
  await broker.get(`/uploads/${file}`).expect(403);
  await other.get(`/uploads/${file}`).expect(403);

  await customer.delete(`/api/tractors/${id}`).expect(204);
  assert.deepEqual(fs.readdirSync(uploadDir), []);
});

test('brokers ask questions answered from the closest document chunks; ID text is never stored', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const other = await signup(app, 'customer', '9876543211');
  const broker = await signup(app, 'broker', '9123456789');
  const { body } = await postTractor(customer).expect(201);
  const id = body.tractor.id;

  // Before any papers, questions are answered from the photo descriptions made by the photo check.
  await checkPhotos(customer, id);
  let res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'are the tyres worn?' }).expect(200);
  assert.match(res.body.answer, /-> Photo \(Front\): Red tractor, front view\. Rear tyres worn/);

  await addGoodDocs(customer, id);
  res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'how worn are the tyres?' }).expect(200);
  assert.match(res.body.answer, /-> Photo \(Front\)/);
  res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'Which insurer covers third party liability?' }).expect(200);
  assert.match(res.body.answer, /^Which insurer.* -> Insurance/);
  res = await customer.post(`/api/tractors/${id}/ask`).send({ question: 'what colour is it?' }).expect(200);
  assert.match(res.body.answer, /-> RC book/);
  res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'should not be kept aadhaar 4321' }).expect(200);
  assert.doesNotMatch(res.body.answer.split(' -> ')[1], /should not be kept|4321|Owner ID/);

  // Off-topic questions get a fixed answer, not the model's.
  res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'what is the weather in Pune?' }).expect(200);
  assert.equal(res.body.offTopic, true);
  assert.match(res.body.answer, /only answer questions about this tractor/);

  await other.post(`/api/tractors/${id}/ask`).send({ question: 'x' }).expect(403);
  await request(app).post(`/api/tractors/${id}/ask`).send({ question: 'x' }).expect(401);
  await broker.post(`/api/tractors/${id}/ask`).send({ question: ' ' }).expect(400);
  await broker.post('/api/tractors/999/ask').send({ question: 'x' }).expect(404);
});

test('photos are checked once per post or save, all together and against the form', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const broker = await signup(app, 'broker', '9123456789');

  // The AI is down: the listing is still saved, its photos show as not checked yet and nothing is answerable.
  fakeAi.photosDown = true;
  const { body } = await postTractor(customer).expect(201);
  const id = body.tractor.id;
  assert.equal(body.tractor.verification.photos.status, 'pending');
  await customer.post(`/api/tractors/${id}/photos/check`).expect(503);
  let res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'tyres?' }).expect(200);
  assert.match(res.body.answer, /Nothing has been added/);

  // One check covers every photo; questions don't repeat it.
  fakeAi.photosDown = false;
  const before = fakeAi.photoChecks;
  res = await checkPhotos(customer, id);
  assert.equal(res.body.tractor.verification.photos.status, 'verified');
  res = await broker.post(`/api/tractors/${id}/ask`).send({ question: 'tyres worn?' }).expect(200);
  assert.match(res.body.answer, /-> Photo \(/);
  assert.equal(fakeAi.photoChecks - before, 1);

  // Every saved edit needs a new check, which compares the photos with the form again.
  res = await editTractor(customer, id, { brand: 'Swaraj', hoursUsed: '900', description: 'Good, new tyres' }).expect(200);
  assert.equal(res.body.tractor.verification.photos.status, 'pending');
  res = await checkPhotos(customer, id);
  assert.equal(fakeAi.photoChecks - before, 2);
  const { status, issues } = res.body.tractor.verification.photos;
  assert.equal(status, 'rejected');
  assert.deepEqual(issues, [
    'The tractor in the photos does not look like a Swaraj 575 DI',
    'The hour meter shows about 2500 hours, but the form says 900',
    'The description says new tyres, but the rear tyres look worn',
  ]);
  assert.equal(res.body.tractor.verification.complete, false);

  // A small difference in hours is fine.
  await editTractor(customer, id, { hoursUsed: '2450' }).expect(200);
  res = await checkPhotos(customer, id);
  assert.equal(res.body.tractor.verification.photos.status, 'verified');
});

test('assistant fills the form from a chat, keeping only valid values', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  const broker = await signup(app, 'broker', '9123456789');
  const messages = [{ role: 'user', content: 'माझा महिंद्रा ५७५ विकायचा आहे, बारामती' }];

  const res = await customer.post('/api/assistant/form').send({ messages, form: { expectedPrice: 500000, hoursUsed: -5 } }).expect(200);
  assert.match(res.body.reply, /ट्रॅक्टर/);
  assert.deepEqual(res.body.fields, {
    brand: 'Mahindra', model: '575 DI', year: null, hoursUsed: null, expectedPrice: 500000, location: 'Baramati', description: null,
  });
  // The form sent to the assistant was cleaned too.
  assert.equal(fakeAi.calls.at(-1).form.hoursUsed, null);

  // Off-topic turns (flagged by the model, or with an overlong reply) get a fixed reply and leave the form alone.
  const form = { brand: 'Swaraj', model: null, year: 2018, hoursUsed: null, expectedPrice: null, location: null, description: null };
  for (const content of ['who won the cricket match?', 'write me a poem']) {
    const off = await customer.post('/api/assistant/form').send({ messages: [{ role: 'user', content }], form }).expect(200);
    assert.equal(off.body.offTopic, true);
    assert.match(off.body.reply, /only help with listing your tractor/);
    assert.deepEqual(off.body.fields, form);
  }

  await broker.post('/api/assistant/form').send({ messages, form: {} }).expect(403);
  await customer.post('/api/assistant/form').send({ messages: [], form: {} }).expect(400);
  await customer.post('/api/assistant/form').send({ messages: [...messages, { role: 'assistant', content: 'hi' }], form: {} }).expect(400);
  await customer.post('/api/assistant/form').send({ messages: [{ role: 'system', content: 'x' }], form: {} }).expect(400);
});

test('logout clears the session', async () => {
  const { app } = await setup();
  const customer = await signup(app, 'customer', '9876543210');
  await customer.get('/api/auth/me').expect(200);
  await customer.post('/api/auth/logout').expect(204);
  await customer.get('/api/auth/me').expect(401);
});

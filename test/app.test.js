import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';

// Smallest valid PNG (1x1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function setup() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tractor-test-'));
  const app = createApp({ db: createDb(), config: { jwtSecret: 'test', secureCookies: false, uploadDir } });
  return { app, uploadDir };
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
const postTractor = (agent, fields = {}, photos = 1) =>
  tractorForm(agent.post('/api/tractors'), fields, Array.isArray(photos) ? photos : ANGLES.slice(0, photos));

const editTractor = (agent, id, fields = {}, angles = []) => tractorForm(agent.put(`/api/tractors/${id}`), fields, angles);

test('customer and broker logins are separate', async () => {
  const { app } = setup();
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
  const { app } = setup();
  const base = { name: 'A', phone: '9876543210', password: 'secret123', role: 'customer' };
  await request(app).post('/api/auth/register').send({ ...base, phone: '123' }).expect(400);
  await request(app).post('/api/auth/register').send({ ...base, password: '1' }).expect(400);
  await request(app).post('/api/auth/register').send({ ...base, role: 'admin' }).expect(400);
});

test('customer posts a tractor with photos; broker sees it with photos and contact', async () => {
  const { app } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  const broker = await signup(app, 'broker', '9123456789');

  const created = await postTractor(customer, {}, ['engine', 'rear', 'front']).expect(201);
  // Photos come back in angle order, front first (it is the cover).
  assert.deepEqual(created.body.tractor.photos.map((p) => p.angle), ['front', 'rear', 'engine']);

  const mine = await customer.get('/api/tractors/mine').expect(200);
  assert.equal(mine.body.tractors.length, 1);

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
  const { app } = setup();
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
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer, {}, ['front', 'rear', 'left']).expect(201);
  const { id, photos } = body.tractor;
  const [front, rear, left] = photos;

  const edited = await editTractor(customer, id, { brand: 'Swaraj', expectedPrice: '480000', description: 'New tyres' }, ['front', 'right'])
    .field('removePhotoIds', String(rear.id))
    .expect(200);
  const t = edited.body.tractor;
  assert.equal(t.brand, 'Swaraj');
  assert.equal(t.expectedPrice, 480000);
  assert.equal(t.description, 'New tyres');
  assert.deepEqual(t.photos.map((p) => p.angle), ['front', 'left', 'right']);
  assert.notEqual(t.photos[0].id, front.id); // front was replaced
  assert.equal(t.photos[1].id, left.id); // left untouched

  // Replaced and removed photos are gone from disk and no longer served.
  assert.equal(fs.readdirSync(uploadDir).length, 3);
  await customer.get(front.url).expect(404);
  await customer.get(rear.url).expect(404);

  // Editing details alone keeps the photos.
  const again = await editTractor(customer, id, { model: '744 FE' }).expect(200);
  assert.equal(again.body.tractor.photos.length, 3);
});

test('edit validates input, keeps at least one photo, and cleans up files on failure', async () => {
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer, {}, 2).expect(201);
  const { id, photos } = body.tractor;
  const allIds = photos.map((p) => p.id).join(',');

  const res = await editTractor(customer, id).field('removePhotoIds', allIds).expect(400);
  assert.match(res.body.error, /at least one photo/);
  await editTractor(customer, id, { year: '1800' }, ['engine']).expect(400);
  assert.equal(fs.readdirSync(uploadDir).length, 2);

  // Removing every old photo is fine when a new one is added in the same edit.
  const ok = await editTractor(customer, id, {}, ['tyres']).field('removePhotoIds', allIds).expect(200);
  assert.deepEqual(ok.body.tractor.photos.map((p) => p.angle), ['tyres']);
  assert.equal(fs.readdirSync(uploadDir).length, 1);
});

test('post requires photos and valid fields, and cleans up files on failure', async () => {
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  await postTractor(customer, {}, 0).expect(400);
  await postTractor(customer, { year: '1800' }, 2).expect(400);
  await customer.post('/api/tractors').field('brand', 'X').field('model', 'Y').field('year', '2019').field('location', 'Z')
    .attach('photo_front', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' })
    .expect(400);
  await postTractor(customer, {}, ['front', 'front']).expect(400); // two photos for one angle
  await postTractor(customer, {}, ['roof']).expect(400); // unknown angle
  assert.deepEqual(fs.readdirSync(uploadDir), []);
});

test('deleting a post removes its photos', async () => {
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer, {}, 2).expect(201);
  assert.equal(fs.readdirSync(uploadDir).length, 2);
  await customer.delete(`/api/tractors/${body.tractor.id}`).expect(204);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  await customer.get(body.tractor.photos[0].url).expect(404);
});

test('logout clears the session', async () => {
  const { app } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  await customer.get('/api/auth/me').expect(200);
  await customer.post('/api/auth/logout').expect(204);
  await customer.get('/api/auth/me').expect(401);
});

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

const postTractor = (agent, fields = {}, photos = 1) => {
  const req = agent.post('/api/tractors')
    .field('brand', 'Mahindra').field('model', '575 DI').field('year', '2019')
    .field('hoursUsed', '2500').field('expectedPrice', '550000').field('location', 'Ludhiana');
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  for (let i = 0; i < photos; i++) req.attach('photos', PNG, `photo${i}.png`);
  return req;
};

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

  const created = await postTractor(customer, {}, 3).expect(201);
  assert.equal(created.body.tractor.photos.length, 3);

  const mine = await customer.get('/api/tractors/mine').expect(200);
  assert.equal(mine.body.tractors.length, 1);

  const all = await broker.get('/api/tractors').expect(200);
  assert.equal(all.body.tractors.length, 1);
  const t = all.body.tractors[0];
  assert.equal(t.customer.phone, '9876543210');
  assert.equal(t.expectedPrice, 550000);

  const photo = await broker.get(t.photos[0]).expect(200);
  assert.equal(photo.headers['content-type'], 'image/png');
  await customer.get(t.photos[0]).expect(200);

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
  const photoUrl = body.tractor.photos[0];

  await request(app).get('/api/tractors').expect(401);
  await customer.get('/api/tractors').expect(403); // customers can't browse everyone's posts
  await postTractor(broker).expect(403); // brokers don't post
  await request(app).get(photoUrl).expect(401);
  await other.get(photoUrl).expect(403);
  await other.delete(`/api/tractors/${body.tractor.id}`).expect(403);
});

test('post requires photos and valid fields, and cleans up files on failure', async () => {
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  await postTractor(customer, {}, 0).expect(400);
  await postTractor(customer, { year: '1800' }, 2).expect(400);
  await customer.post('/api/tractors').field('brand', 'X').field('model', 'Y').field('year', '2019').field('location', 'Z')
    .attach('photos', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' })
    .expect(400);
  await postTractor(customer, {}, 9).expect(400); // more than 8 photos
  assert.deepEqual(fs.readdirSync(uploadDir), []);
});

test('deleting a post removes its photos', async () => {
  const { app, uploadDir } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  const { body } = await postTractor(customer, {}, 2).expect(201);
  assert.equal(fs.readdirSync(uploadDir).length, 2);
  await customer.delete(`/api/tractors/${body.tractor.id}`).expect(204);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  await customer.get(body.tractor.photos[0]).expect(404);
});

test('logout clears the session', async () => {
  const { app } = setup();
  const customer = await signup(app, 'customer', '9876543210');
  await customer.get('/api/auth/me').expect(200);
  await customer.post('/api/auth/logout').expect(204);
  await customer.get('/api/auth/me').expect(401);
});

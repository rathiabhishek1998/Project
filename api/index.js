// Vercel entry point: every /api/* and /uploads/* request is routed here (see vercel.json).
// The app is built once per server instance and reused for the requests it handles.
import { buildApp } from '../src/setup.js';

let app;

export default async function handler(req, res) {
  app ??= buildApp().catch((err) => {
    app = undefined; // try again on the next request
    throw err;
  });
  (await app)(req, res);
}

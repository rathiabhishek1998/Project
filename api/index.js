// Vercel entry point: every /api/* and /uploads/* request is routed here (see vercel.json).
// The app is built once per server instance and reused for the requests it handles.

let app;

async function loadApp() {
  // Imported here, not at the top, so that even a failure while loading the code is reported below.
  const { buildApp } = await import('../src/setup.js');
  return buildApp();
}

export default async function handler(req, res) {
  app ??= loadApp().catch((err) => {
    app = undefined; // try again on the next request
    throw err;
  });
  let ready;
  try {
    ready = await app;
  } catch (err) {
    // Without this, Vercel only shows FUNCTION_INVOCATION_FAILED and the page says "Something went wrong".
    console.error('Server setup failed:', err);
    const reason = err.name === 'ConfigError' ? err.message : `${err.code ?? err.name} (details in the Vercel logs)`;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: `Server setup problem: ${reason}` }));
  }
  ready(req, res);
}

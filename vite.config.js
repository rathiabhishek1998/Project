import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React app lives in client/ and builds to dist/, which Express (locally) and Vercel serve.
export default defineConfig({
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [
    react(),
    {
      // `npm run dev` runs the Express API inside the Vite dev server, so one command and one port
      // serve both the React app (with hot reload) and /api, /uploads. Restart it after changing src/.
      name: 'express-api',
      async configureServer(server) {
        const { buildApp } = await import('./src/setup.js');
        const app = await buildApp();
        server.middlewares.use((req, res, next) =>
          req.url.startsWith('/api/') || req.url.startsWith('/uploads/') ? app(req, res) : next());
      },
    },
  ],
});

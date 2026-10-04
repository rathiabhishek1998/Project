import { buildApp } from './setup.js';

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp();
app.listen(port, () => {
  console.log(`Tractor marketplace running at http://localhost:${port}`);
});

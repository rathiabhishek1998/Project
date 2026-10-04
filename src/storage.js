// Where tractor photos are kept. Both stores take a photo's filename (e.g. "<uuid>.jpg")
// and are only reached through the app, which checks who may see each photo.
import { del, get, put } from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Photos in a local folder (for running on your own computer, and for tests). */
export function diskStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (name) => path.join(dir, path.basename(name));
  return {
    save: (name, buffer) => fs.promises.writeFile(file(name), buffer),
    remove: async (names) => {
      for (const name of names) await fs.promises.rm(file(name), { force: true });
    },
    send: (res, name) =>
      fs.existsSync(file(name)) ? res.sendFile(file(name)) : res.status(404).end(),
  };
}

/** Photos in a private Vercel Blob store (for Vercel, where the server has no lasting disk). */
export function blobStorage() {
  const access = 'private';
  const key = (name) => `photos/${path.basename(name)}`;
  return {
    save: (name, buffer, contentType) => put(key(name), buffer, { access, contentType, addRandomSuffix: false }),
    remove: async (names) => {
      if (names.length) await del(names.map(key));
    },
    send: async (res, name) => {
      const photo = await get(key(name), { access });
      if (!photo) return res.status(404).end();
      res.type(photo.blob.contentType);
      // A filename is never reused for different content, so browsers can keep it.
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      await pipeline(Readable.fromWeb(photo.stream), res);
    },
  };
}

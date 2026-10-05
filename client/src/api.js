// Talking to the server, plus small formatting helpers shared by the pages.

export async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 204) return null;
  if (res.status === 413) throw new Error('The photos are too large to upload. Try fewer or smaller photos.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

export const postJson = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const rupees = (n) => (n == null ? 'Price not given' : `₹${Number(n).toLocaleString('en-IN')}`);

// Angles a customer can photograph, in display order (must match PHOTO_ANGLES in src/app.js).
export const PHOTO_ANGLES = {
  front: 'Front', rear: 'Back', left: 'Left side', right: 'Right side',
  engine: 'Engine', dashboard: 'Dashboard & seat', tyres: 'Tyres', other: 'Other',
};
// Photos posted before angles existed have none.
export const angleLabel = (angle) => PHOTO_ANGLES[angle] ?? 'Photo';

// The server stores SQLite UTC timestamps like "2024-05-01 10:00:00".
export const postedDate = (createdAt) => new Date(createdAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN');

// Phone photos are several MB each. Shrink them so all angles fit in one upload
// (the server accepts at most 4.5 MB per request) and upload quickly on mobile data.
export async function shrinkPhoto(file, maxSide = 1400) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (blob && blob.size < file.size) return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  } catch {
    // Browser couldn't read the image here; send it as it is.
  }
  return file;
}

// Talking to the server, plus small formatting helpers shared by the pages.

// Fired when the server says the login has ended; the page then goes to the login form and says why.
// event.detail is 'idle' (too long without activity) or 'elsewhere' (logged out from another device).
export const SESSION_ENDED = 'session-ended';
export const ENDED_REASONS = { session_ended: 'idle', session_revoked: 'elsewhere' };

export async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 204) return null;
  if (res.status === 413) throw new Error('The photos are too large to upload. Try fewer or smaller photos.');
  const data = await res.json().catch(() => ({}));
  if (ENDED_REASONS[data.code]) window.dispatchEvent(new CustomEvent(SESSION_ENDED, { detail: ENDED_REASONS[data.code] }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { code: data.code });
  return data;
}

export const postJson = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const rupees = (n) => (n == null ? 'Price not given' : `₹${Number(n).toLocaleString('en-IN')}`);

// Angles a customer can photograph, in display order (must match PHOTO_LABELS in src/verify.js).
export const PHOTO_ANGLES = {
  front: 'Front', rear: 'Back', left: 'Left side', right: 'Right side',
  engine: 'Engine', dashboard: 'Dashboard & seat', tyres: 'Tyres', other: 'Other',
};
// A listing needs at least this many photos (must match MIN_PHOTOS in src/verify.js).
export const MIN_PHOTOS = 4;

// The papers a listing needs (must match DOC_TYPES in src/verify.js). The loan NOC is needed only when the RC shows a loan.
export const DOC_TYPES = {
  rc: { label: 'RC book', required: true, hint: 'Registration certificate / smart card, front and back in one photo or PDF' },
  insurance: { label: 'Insurance', required: true, hint: 'Current insurance policy or certificate' },
  owner_id: { label: 'Owner ID proof', required: true, hint: 'Aadhaar, PAN, voter ID or driving licence of the RC owner. Only the last 4 digits are kept' },
  loan_noc: { label: 'Loan NOC', required: false, hint: 'Only if the tractor was bought on a loan: the bank’s no-objection certificate' },
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

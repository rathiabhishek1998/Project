// Checks a listing's photos and documents against each other and against the listing.
// Claude looks at the photos and reads each document (see ai.js); these rules decide, in plain code, whether the
// listing is complete, so every pass or fail has a clear reason the customer can act on.

export const DOC_TYPES = {
  rc: 'RC book',
  insurance: 'Insurance',
  loan_noc: 'Loan NOC',
  owner_id: 'Owner ID proof',
};

const letters = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const plate = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "R. Patil" matches "Ramesh Patil": every word of the shorter name is in the longer one (initials count). */
export function sameName(a, b) {
  const [short, long] = [letters(a), letters(b)].sort((x, y) => x.length - y.length);
  if (!short.length) return false;
  return short.every((w) => long.some((l) => l === w || (w.length === 1 && l.startsWith(w)) || (l.length === 1 && w.startsWith(l))));
}

const sameBrand = (a, b) => {
  const [x, y] = [letters(a).join(''), letters(b).join('')];
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
};

/** Is this document about the same tractor as the RC book (same registration or chassis number)? */
const sameVehicle = (doc, rc) =>
  (doc.registration_number && plate(doc.registration_number) === plate(rc.registration_number)) ||
  (doc.chassis_number && plate(doc.chassis_number) === plate(rc.chassis_number));

function documentIssues(type, d, { tractor, rc, today }) {
  const issues = [];
  if (d.document_type !== type) {
    const found = DOC_TYPES[d.document_type] ? `the ${DOC_TYPES[d.document_type]}` : 'a different document';
    issues.push(`This file looks like ${found}. Upload the ${DOC_TYPES[type]} here`);
    return issues;
  }
  if (!d.readable) issues.push('The photo is not clear enough to read. Upload a sharper, well-lit photo of the whole page');
  for (const sign of d.signs_of_tampering ?? []) issues.push(`Looks edited: ${sign}`);

  if (type === 'rc') {
    if (!d.registration_number) issues.push('Registration number not found');
    if (!d.owner_name) issues.push("Owner's name not found");
    if (d.make && !sameBrand(d.make, tractor.brand)) issues.push(`RC says the make is ${d.make}, but the listing says ${tractor.brand}`);
    if (d.manufacture_year && d.manufacture_year !== tractor.year) {
      issues.push(`RC says it was made in ${d.manufacture_year}, but the listing says ${tractor.year}`);
    }
  }
  if (type === 'insurance') {
    if (rc && !sameVehicle(d, rc)) issues.push('This insurance is for a different vehicle than the RC book');
    if (!d.valid_until) issues.push('Expiry date not found');
    else if (d.valid_until < today) issues.push(`Insurance expired on ${d.valid_until}`);
  }
  if (type === 'loan_noc' && rc && !sameVehicle(d, rc)) issues.push('This NOC is for a different vehicle than the RC book');
  if (type === 'owner_id') {
    if (!d.owner_name) issues.push('Name not found on the ID');
    else if (rc?.owner_name && !sameName(d.owner_name, rc.owner_name)) {
      issues.push(`Name on the ID (${d.owner_name}) does not match the RC owner (${rc.owner_name})`);
    }
  }
  return issues;
}

// Angles a customer can photograph, in display order (the first one present is the cover), with their labels as on the page.
export const PHOTO_LABELS = {
  front: 'Front', rear: 'Back', left: 'Left side', right: 'Right side',
  engine: 'Engine', dashboard: 'Dashboard & seat', tyres: 'Tyres', other: 'Other',
};
export const MIN_PHOTOS = 4;

const photoLabel = (angle) => PHOTO_LABELS[angle] ?? 'earlier';

/**
 * The check of a listing's photos against its form. check is what Claude found looking at all of them together
 * (see ai.checkPhotos), or null when they have not been checked yet. Status: verified | rejected | pending | missing.
 */
function photoStatus(tractor, photoCount, check) {
  if (photoCount < MIN_PHOTOS) {
    return { status: 'missing', issues: [`Add at least ${MIN_PHOTOS} photos (${photoCount} so far)`] };
  }
  if (!check) return { status: 'pending', issues: [] };
  const issues = [];
  for (const p of check.photos) {
    if (!p.shows_tractor) issues.push(`The ${photoLabel(p.angle)} photo does not show a tractor`);
    else if (p.angle in PHOTO_LABELS && p.angle !== 'other' && !p.matches_angle) {
      issues.push(`The ${photoLabel(p.angle)} photo does not show the ${photoLabel(p.angle).toLowerCase()} of the tractor`);
    }
    if (p.from_internet) issues.push(`The ${photoLabel(p.angle)} photo looks copied from the internet or a brochure`);
  }
  if (!check.same_tractor) issues.push('The photos seem to show more than one tractor');
  if (!check.matches_listing) issues.push(`The tractor in the photos does not look like a ${tractor.brand} ${tractor.model}`);
  // Meters are read at a glance and hours keep going up, so allow some difference.
  const hours = tractor.hours_used;
  const reading = check.hour_meter_reading;
  if (reading != null && hours != null && Math.abs(reading - hours) > Math.max(100, hours * 0.1)) {
    issues.push(`The hour meter shows about ${reading} hours, but the form says ${hours}`);
  }
  issues.push(...(check.contradictions ?? []));
  return { status: issues.length ? 'rejected' : 'verified', issues, checkedAt: check.checkedAt };
}

/**
 * tractor: a tractors row ({ brand, model, year, hours_used }); docs: [{ type, data, createdAt }] where data is what Claude read;
 * photos: { count, check } (see photoStatus).
 * Returns { complete, photos: { status, issues }, documents: { [type]: { status, issues, uploadedAt? } } }, document
 * status being verified | rejected | missing | not_required. A loan NOC is needed only when the RC book shows a financier.
 */
export function verifyListing(tractor, docs, photos, today = new Date().toISOString().slice(0, 10)) {
  const byType = Object.fromEntries(docs.map((d) => [d.type, d]));
  const rc = byType.rc?.data.document_type === 'rc' ? byType.rc.data : null;
  const documents = {};
  for (const type of Object.keys(DOC_TYPES)) {
    const doc = byType[type];
    if (!doc) {
      const required = type !== 'loan_noc' || !rc || Boolean(rc.financier);
      documents[type] = { status: required ? 'missing' : 'not_required', issues: [] };
      continue;
    }
    const issues = documentIssues(type, doc.data, { tractor, rc, today });
    documents[type] = { status: issues.length ? 'rejected' : 'verified', issues, uploadedAt: doc.createdAt };
  }
  const photoResult = photoStatus(tractor, photos.count, photos.check);
  const complete = photoResult.status === 'verified' &&
    Object.values(documents).every((d) => d.status === 'verified' || d.status === 'not_required');
  return { complete, photos: photoResult, documents };
}

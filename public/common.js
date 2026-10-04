// Shared helpers used by every page.

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 204) return null;
  if (res.status === 413) throw new Error('The photos are too large to upload. Try fewer or smaller photos.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function postJson(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Returns the logged-in user, or redirects to the right login page if not logged in as `role`. */
async function requireLogin(role) {
  try {
    const { user } = await api('/api/auth/me');
    if (user.role === role) return user;
  } catch {}
  location.href = `/login?role=${role}`;
  return new Promise(() => {});
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/';
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const rupees = (n) => (n == null ? 'Price not given' : `₹${Number(n).toLocaleString('en-IN')}`);

// Angles a customer can photograph, in display order (must match PHOTO_ANGLES in src/app.js).
const PHOTO_ANGLES = {
  front: 'Front', rear: 'Back', left: 'Left side', right: 'Right side',
  engine: 'Engine', dashboard: 'Dashboard & seat', tyres: 'Tyres', other: 'Other',
};
// Photos posted before angles existed have none.
const angleLabel = (angle) => PHOTO_ANGLES[angle] ?? 'Photo';

/** HTML for one tractor card. Pass showContact to include the customer's phone (broker view). */
function tractorCard(t, { showContact = false, ownerActions = false } = {}) {
  const [cover, ...rest] = t.photos;
  return `
    <div class="card tractor">
      <img class="cover" src="${cover.url}" alt="${escapeHtml(t.brand)} ${escapeHtml(t.model)}" title="${angleLabel(cover.angle)}" data-zoom>
      <div class="body">
        <h3>${escapeHtml(t.brand)} ${escapeHtml(t.model)}</h3>
        <div class="price">${rupees(t.expectedPrice)}</div>
        <div class="muted">${t.year}${t.hoursUsed != null ? ` · ${t.hoursUsed.toLocaleString('en-IN')} hrs` : ''} · 📍 ${escapeHtml(t.location)}</div>
        ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}
        ${rest.length ? `<div class="thumbs">${rest.map((p) => `<img src="${p.url}" alt="${angleLabel(p.angle)}" title="${angleLabel(p.angle)}" data-zoom>`).join('')}</div>` : ''}
        <div class="muted" style="font-size:.8rem;margin-top:4px">📷 ${t.photos.length} photo${t.photos.length === 1 ? '' : 's'} · tap to enlarge</div>
        ${showContact ? `
          <div class="contact">
            <strong>${escapeHtml(t.customer.name)}</strong><br>
            <a href="tel:+91${t.customer.phone}">📞 +91 ${t.customer.phone}</a>
          </div>` : ''}
        ${ownerActions ? `
          <div class="contact actions">
            <button class="btn btn-light" data-edit="${t.id}">✏️ Edit listing</button>
            <button class="btn btn-danger" data-delete="${t.id}">Delete post</button>
          </div>` : ''}
        <div class="muted" style="font-size:.8rem;margin-top:8px">Posted ${new Date(t.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN')}</div>
      </div>
    </div>`;
}

// Click any photo marked data-zoom to view it full screen.
document.addEventListener('click', (e) => {
  const box = document.getElementById('lightbox');
  if (!box) return;
  if (e.target.matches('[data-zoom]')) {
    box.querySelector('img').src = e.target.src;
    box.querySelector('.caption').textContent = e.target.title;
    box.classList.add('open');
  } else if (e.target.closest('#lightbox')) {
    box.classList.remove('open');
  }
});

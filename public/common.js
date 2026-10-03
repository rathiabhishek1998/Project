// Shared helpers used by every page.

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 204) return null;
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

/** HTML for one tractor card. Pass showContact to include the customer's phone (broker view). */
function tractorCard(t, { showContact = false, showDelete = false } = {}) {
  const [cover, ...rest] = t.photos;
  return `
    <div class="card tractor">
      <img class="cover" src="${cover}" alt="${escapeHtml(t.brand)} ${escapeHtml(t.model)}" data-zoom>
      <div class="body">
        <h3>${escapeHtml(t.brand)} ${escapeHtml(t.model)}</h3>
        <div class="price">${rupees(t.expectedPrice)}</div>
        <div class="muted">${t.year}${t.hoursUsed != null ? ` · ${t.hoursUsed.toLocaleString('en-IN')} hrs` : ''} · 📍 ${escapeHtml(t.location)}</div>
        ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}
        ${rest.length ? `<div class="thumbs">${rest.map((src) => `<img src="${src}" alt="" data-zoom>`).join('')}</div>` : ''}
        ${showContact ? `
          <div class="contact">
            <strong>${escapeHtml(t.customer.name)}</strong><br>
            <a href="tel:+91${t.customer.phone}">📞 +91 ${t.customer.phone}</a>
          </div>` : ''}
        ${showDelete ? `<div class="contact"><button class="btn btn-danger" data-delete="${t.id}">Delete post</button></div>` : ''}
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
    box.classList.add('open');
  } else if (e.target.closest('#lightbox')) {
    box.classList.remove('open');
  }
});

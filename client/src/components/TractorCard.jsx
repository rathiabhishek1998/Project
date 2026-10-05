import { angleLabel, postedDate, rupees } from '../api.js';

/**
 * One tractor post. showContact adds the customer's name and phone (broker view);
 * onEdit / onDelete add the owner's buttons (customer view). onZoom(src, caption) opens a photo.
 */
export default function TractorCard({ tractor: t, showContact = false, onEdit, onDelete, onZoom }) {
  const [cover, ...rest] = t.photos;
  const n = t.photos.length;
  return (
    <div className="card tractor">
      <img
        className="cover"
        src={cover.url}
        alt={`${t.brand} ${t.model}`}
        title={angleLabel(cover.angle)}
        onClick={() => onZoom(cover.url, angleLabel(cover.angle))}
      />
      <div className="body">
        <h3>{t.brand} {t.model}</h3>
        <div className="price">{rupees(t.expectedPrice)}</div>
        <div className="muted">
          {t.year}
          {t.hoursUsed != null && ` · ${t.hoursUsed.toLocaleString('en-IN')} hrs`} · 📍 {t.location}
        </div>
        {t.description && <p>{t.description}</p>}
        {rest.length > 0 && (
          <div className="thumbs">
            {rest.map((p) => (
              <img
                key={p.id}
                src={p.url}
                alt={angleLabel(p.angle)}
                title={angleLabel(p.angle)}
                onClick={() => onZoom(p.url, angleLabel(p.angle))}
              />
            ))}
          </div>
        )}
        <div className="muted small">📷 {n} photo{n === 1 ? '' : 's'} · tap to enlarge</div>
        {showContact && (
          <div className="contact">
            <strong>{t.customer.name}</strong>
            <br />
            <a href={`tel:+91${t.customer.phone}`}>📞 +91 {t.customer.phone}</a>
          </div>
        )}
        {onEdit && (
          <div className="contact actions">
            <button className="btn btn-light" onClick={() => onEdit(t)}>✏️ Edit listing</button>
            <button className="btn btn-danger" onClick={() => onDelete(t)}>Delete post</button>
          </div>
        )}
        <div className="muted small posted">Posted {postedDate(t.createdAt)}</div>
      </div>
    </div>
  );
}

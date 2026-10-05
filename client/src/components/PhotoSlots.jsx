import { useEffect, useState } from 'react';
import { PHOTO_ANGLES } from '../api.js';

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

/**
 * One photo box per angle. `files` holds newly picked photos by angle; `existing` holds the
 * post's saved photos still kept (when editing). onPick(angle, file) and onRemove(angle) change them;
 * onRemoveExisting(id) removes a saved photo that fits no angle (posted before angles existed).
 */
export default function PhotoSlots({ files, existing, onPick, onRemove, onRemoveExisting }) {
  // Previews for newly picked photos, released when they are replaced or the form closes.
  const [previews, setPreviews] = useState({});
  useEffect(() => {
    const urls = Object.fromEntries(Object.entries(files).map(([angle, file]) => [angle, URL.createObjectURL(file)]));
    setPreviews(urls);
    return () => Object.values(urls).forEach(URL.revokeObjectURL);
  }, [files]);

  const angles = Object.keys(PHOTO_ANGLES);
  const srcFor = (angle) => previews[angle] ?? existing.find((p) => p.angle === angle)?.url;
  const legacy = existing.filter((p) => !(p.angle in PHOTO_ANGLES));
  const filled = angles.filter(srcFor).length;

  return (
    <div className="photo-section">
      <div className="angles-head">
        <strong>📸 Photos from every angle</strong>
        <span className="count">{filled === angles.length ? '✓ All angles added' : `${filled} of ${angles.length} angles`}</span>
      </div>
      <div className="progress"><div style={{ width: `${(filled / angles.length) * 100}%` }} /></div>
      <p className="muted hint">Tap a box to take or choose a photo. More angles help brokers trust your tractor.</p>

      <div className="slots">
        {angles.map((angle, i) => {
          const label = PHOTO_ANGLES[angle];
          const src = srcFor(angle);
          return (
            <div className={`slot${src ? ' filled' : ''}`} key={angle}>
              {i === 0 && <span className="cover-badge">COVER</span>}
              <label title={label}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files[0];
                    e.target.value = ''; // so picking the same file again still counts as a change
                    if (file) onPick(angle, file);
                  }}
                />
                <span className="slot-empty"><CameraIcon /><b>{label}</b><small>Add photo</small></span>
                {src && <img src={src} alt={label} />}
                <span className="slot-tag">{label}</span>
                <span className="slot-change">Change</span>
              </label>
              <button type="button" className="remove" title="Remove photo" aria-label={`Remove ${label} photo`} onClick={() => onRemove(angle)}>✕</button>
            </div>
          );
        })}
      </div>

      {legacy.length > 0 && (
        <div className="slots">
          {legacy.map((p) => (
            <div className="slot filled" key={p.id}>
              <label><img src={p.url} alt="" /><span className="slot-tag">Earlier photo</span></label>
              <button type="button" className="remove" title="Remove photo" aria-label="Remove photo" onClick={() => onRemoveExisting(p.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

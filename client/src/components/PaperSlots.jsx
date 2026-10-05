import { DOC_TYPES } from '../api.js';

const SAVED_STATUS = { verified: 'Verified', rejected: 'Needs attention', missing: '', not_required: '' };

/**
 * The papers part of the listing form. files: newly chosen files by type; saved: the listing's document
 * results when editing (verification.documents), else null. onPick(type, file) / onClear(type) change files.
 */
export default function PaperSlots({ files, saved, onPick, onClear }) {
  return (
    <div className="photo-section papers">
      <div className="angles-head"><strong>📄 Papers</strong></div>
      <p className="muted hint">Clear photos or PDFs, up to 4 MB each. They are checked when you post, and only you can see them.</p>
      {Object.entries(DOC_TYPES).map(([type, { label, required, hint }]) => {
        const file = files[type];
        const savedDoc = saved?.[type]?.uploadedAt ? saved[type] : null;
        return (
          <div className="paper" key={type}>
            <div className="doc-body">
              <b>{label}</b>{required ? <span className="req"> *</span> : <span className="muted"> (if on loan)</span>}
              <div className="muted hint">
                {file ? `📎 ${file.name}` : savedDoc ? `Uploaded · ${SAVED_STATUS[savedDoc.status]}` : hint}
              </div>
            </div>
            <div className="doc-actions">
              <label className="btn btn-light">
                {file || savedDoc ? 'Replace' : 'Choose'}
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden
                  onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPick(type, f); }} />
              </label>
              {file && <button type="button" className="btn btn-danger" onClick={() => onClear(type)} aria-label={`Remove ${label}`}>✕</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

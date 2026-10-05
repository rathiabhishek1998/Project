import { useState } from 'react';
import { api, DOC_TYPES } from '../api.js';

const STATUS = {
  verified: { icon: '✓', text: 'Verified' },
  rejected: { icon: '!', text: 'Needs attention' },
  missing: { icon: '+', text: 'Not added' },
  not_required: { icon: '–', text: 'Not needed (no loan on the RC)' },
  pending: { icon: '…', text: 'Not checked yet' },
};

/** What was checked on one of the customer's listings. Fixes are made with Edit listing, which checks everything again. */
export default function Verification({ tractor, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { complete, photos, documents } = tractor.verification;

  // Runs the photo check again when it could not run while posting (e.g. the AI was unavailable).
  async function checkPhotos() {
    setBusy(true);
    setError('');
    try {
      onChange((await api(`/api/tractors/${tractor.id}/photos/check`, { method: 'POST' })).tractor);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = [
    ['photos', 'Photos', photos],
    ...Object.entries(DOC_TYPES).map(([type, { label }]) => [type, label, documents[type]]),
  ];

  return (
    <div className="documents contact">
      <div className={`listing-status ${complete ? 'ok' : 'todo'}`}>
        {complete ? '✓ Photos and papers verified. Brokers can see this listing' : 'Brokers can’t see this listing yet. Fix the items below with Edit listing'}
      </div>
      <div className="error">{error}</div>
      {rows.map(([key, label, result]) => {
        const status = key === 'photos' && busy ? { icon: '…', text: 'Checking the photos… (up to a minute)' } : STATUS[result.status];
        return (
          <div className={`doc ${key === 'photos' && busy ? 'checking' : result.status}`} key={key}>
            <span className="doc-icon" aria-hidden="true">{status.icon}</span>
            <div className="doc-body">
              <b>{label}</b> <span className="muted">· {status.text}</span>
              {result.issues.length > 0 && <ul className="issues">{result.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
            </div>
            {key === 'photos' && result.status === 'pending' && (
              <div className="doc-actions">
                <button className="btn btn-light" onClick={checkPhotos} disabled={busy}>Check now</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

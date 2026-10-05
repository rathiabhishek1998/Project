import { DOC_TYPES } from '../api.js';

export const STEPS = {
  form: 'Checking the form',
  photos: 'Checking the photos against the form',
  documents: 'Checking the documents',
};

const ICONS = { waiting: '', active: '', done: '✓', failed: '!' };

/** Everything still to fix, from a listing's verification, as "What: problem" lines. */
function problems(verification) {
  const list = verification.photos.issues.map((i) => `Photos: ${i}`);
  if (verification.photos.status === 'pending') list.push('Photos: not checked yet. Use "Check now" on the listing');
  for (const [type, doc] of Object.entries(verification.documents)) {
    const { label } = DOC_TYPES[type];
    if (doc.status === 'missing') list.push(`${label}: not added yet`);
    for (const issue of doc.issues) list.push(`${label}: ${issue}`);
  }
  return list;
}

/**
 * The checks that run when a listing is posted or saved, shown step by step.
 * steps: { form | photos | documents: { status: waiting | active | done | failed, detail } };
 * result: the listing's verification once all steps are over.
 */
export default function CheckProgress({ steps, result, onClose }) {
  const todo = result ? problems(result) : [];
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="check-title">
      <div className="card check-card">
        <h2 id="check-title">{result ? 'Checks finished' : 'Checking your listing…'}</h2>
        <ol className="steps">
          {Object.entries(STEPS).map(([key, label]) => {
            const { status, detail } = steps[key];
            return (
              <li key={key} className={`step ${status}`}>
                <span className="step-icon" aria-hidden="true">{status === 'active' ? <span className="spinner" /> : ICONS[status]}</span>
                <div>
                  <div>{label}{status === 'active' ? '…' : ''}</div>
                  {detail && <div className="muted hint">{detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
        {result && (
          result.complete ? (
            <div className="listing-status ok">✓ Everything matches. Brokers can now see your listing.</div>
          ) : (
            <>
              <div className="listing-status todo">Your listing is saved, but brokers can’t see it until these are fixed (use Edit listing):</div>
              <ul className="issues">{todo.map((t) => <li key={t}>{t}</li>)}</ul>
            </>
          )
        )}
        {result && <button className="btn btn-primary btn-block" onClick={onClose} autoFocus>OK</button>}
      </div>
    </div>
  );
}

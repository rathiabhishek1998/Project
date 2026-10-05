import { useCallback, useEffect, useRef, useState } from 'react';
import { api, DOC_TYPES, MIN_PHOTOS, shrinkPhoto } from '../api.js';
import { useRequireLogin } from '../auth.js';
import Assistant from '../components/Assistant.jsx';
import CheckProgress from '../components/CheckProgress.jsx';
import Header from '../components/Header.jsx';
import { useLightbox } from '../components/Lightbox.jsx';
import PaperSlots from '../components/PaperSlots.jsx';
import PhotoSlots from '../components/PhotoSlots.jsx';
import TractorCard from '../components/TractorCard.jsx';
import Verification from '../components/Verification.jsx';

const FIELDS = ['brand', 'model', 'year', 'hoursUsed', 'expectedPrice', 'location', 'description'];
const EMPTY = Object.fromEntries(FIELDS.map((name) => [name, '']));

export default function Customer() {
  const user = useRequireLogin('customer');
  const [lightbox, zoom] = useLightbox();
  const formRef = useRef(null);

  const [tractors, setTractors] = useState(null);
  const [details, setDetails] = useState(EMPTY);
  const [files, setFiles] = useState({}); // newly picked photos by angle
  const [papers, setPapers] = useState({}); // newly chosen paper files by type
  const [editing, setEditing] = useState(null); // the tractor being edited, or null when posting a new one
  const [removed, setRemoved] = useState([]); // ids of saved photos removed while editing
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatKey, setChatKey] = useState(0); // changed after each post, so the next listing starts a new chat
  const [progress, setProgress] = useState(null); // the checks running after Post / Save (see CheckProgress)

  const load = useCallback(() => api('/api/tractors/mine').then((data) => setTractors(data.tractors)), []);
  useEffect(() => {
    if (user) load().catch((err) => setError(err.message));
  }, [user, load]);

  // Saved photos still kept; a newly picked photo replaces the saved one for its angle when the form is sent.
  const existing = (editing?.photos ?? []).filter((p) => !removed.includes(p.id));

  function resetForm() {
    setDetails(EMPTY);
    setFiles({});
    setPapers({});
    setEditing(null);
    setRemoved([]);
    setError('');
  }

  function startEdit(tractor) {
    resetForm();
    setEditing(tractor);
    setDetails(Object.fromEntries(FIELDS.map((name) => [name, tractor[name] ?? ''])));
    formRef.current.scrollIntoView({ behavior: 'smooth' });
  }

  async function remove(tractor) {
    if (!confirm('Delete this post?')) return;
    try {
      await api(`/api/tractors/${tractor.id}`, { method: 'DELETE' });
      if (editing?.id === tractor.id) resetForm();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function removePhoto(angle) {
    if (files[angle]) {
      // Drop the newly picked photo first; the saved one (if any) shows again.
      setFiles(({ [angle]: _, ...rest }) => rest);
    } else {
      const saved = existing.find((p) => p.angle === angle);
      if (saved) setRemoved((ids) => [...ids, saved.id]);
    }
  }

  const step = (key, status, detail = '') =>
    setProgress((p) => ({ ...p, steps: { ...p.steps, [key]: { status, detail } } }));

  // Posting or saving runs three checks, one after another, while CheckProgress shows how far they are:
  // 1. the form (validated and saved with the photos), 2. the photos against the form, 3. each new paper.
  // Once the form is saved the listing exists; a later step that fails is shown, and can be redone from the listing.
  async function submit(e) {
    e.preventDefault();
    const keptAngles = new Set(existing.map((p) => p.angle));
    const photoCount = existing.length + Object.keys(files).filter((angle) => !keptAngles.has(angle)).length;
    if (photoCount < MIN_PHOTOS) {
      setError(`Add at least ${MIN_PHOTOS} photos of the tractor (${photoCount} so far)`);
      return;
    }
    const missingPapers = Object.entries(DOC_TYPES)
      .filter(([type, { required }]) => required && !papers[type] && !editing?.verification.documents[type].uploadedAt)
      .map(([, { label }]) => label);
    if (missingPapers.length) {
      setError(`Add the ${missingPapers.join(', ')}`);
      return;
    }
    setBusy(true);
    setError('');
    setProgress({ steps: { form: { status: 'active' }, photos: { status: 'waiting' }, documents: { status: 'waiting' } }, result: null });

    let tractor;
    try {
      const body = new FormData();
      for (const [name, value] of Object.entries(details)) body.set(name, value);
      for (const [angle, file] of Object.entries(files)) body.set(`photo_${angle}`, await shrinkPhoto(file));
      if (editing) {
        body.set('removePhotoIds', removed.join(','));
        ({ tractor } = await api(`/api/tractors/${editing.id}`, { method: 'PUT', body }));
      } else {
        ({ tractor } = await api('/api/tractors', { method: 'POST', body }));
      }
    } catch (err) {
      // Nothing was saved: back to the form to fix it.
      setProgress(null);
      setError(err.message);
      setBusy(false);
      return;
    }
    step('form', 'done');
    const newPapers = Object.entries(papers);
    if (!editing) setChatKey((k) => k + 1);
    resetForm();

    step('photos', 'active', `Looking at all ${tractor.photos.length} photos together (up to a minute)`);
    try {
      ({ tractor } = await api(`/api/tractors/${tractor.id}/photos/check`, { method: 'POST' }));
      step('photos', 'done');
    } catch (err) {
      step('photos', 'failed', err.message);
    }

    const failures = [];
    for (const [i, [type, file]] of newPapers.entries()) {
      step('documents', 'active', `Reading the ${DOC_TYPES[type].label} (${i + 1} of ${newPapers.length})`);
      try {
        const body = new FormData();
        // Keep photos of papers sharp enough to read the small print (the server accepts up to 4 MB).
        body.set('file', file.type === 'application/pdf' ? file : await shrinkPhoto(file, 2200));
        ({ tractor } = await api(`/api/tractors/${tractor.id}/documents/${type}`, { method: 'PUT', body }));
      } catch (err) {
        failures.push(`${DOC_TYPES[type].label}: ${err.message}`);
      }
    }
    // Papers that were not replaced are checked against the new form too (the server does this on every read).
    const { photos, documents } = tractor.verification;
    const docProblems = Object.values(documents).filter((d) => d.status === 'rejected' || d.status === 'missing').length;
    if (failures.length) step('documents', 'failed', failures.join('. '));
    else if (docProblems) step('documents', 'failed', `${docProblems} paper${docProblems === 1 ? '' : 's'} need${docProblems === 1 ? 's' : ''} attention`);
    else step('documents', 'done');
    if (photos.status === 'rejected') step('photos', 'failed', `${photos.issues.length} problem${photos.issues.length === 1 ? '' : 's'} found`);

    setProgress((p) => ({ ...p, result: tractor.verification }));
    await load().catch(() => {});
    setBusy(false);
  }

  if (!user) return <Header />;

  // The assistant's values replace what is in the form; values it doesn't know (null) leave the form as it is.
  const applyAssistant = (fields) =>
    setDetails((d) => ({ ...d, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) }));

  const replaceTractor = (updated) => setTractors((list) => list.map((t) => (t.id === updated.id ? updated : t)));

  const field = (name) => ({
    name,
    value: details[name],
    onChange: (e) => setDetails((d) => ({ ...d, [name]: e.target.value })),
  });

  return (
    <>
      <Header user={user} />
      <main className="wrap layout">
        <div className="stack">
          {!editing && <Assistant key={chatKey} form={details} onFields={applyAssistant} />}
          <form className="card" ref={formRef} onSubmit={submit}>
            <h2>{editing ? `Edit ${editing.brand} ${editing.model}` : 'Post your tractor'}</h2>
            <div className="error">{error}</div>
            <div className="row">
              <label>Brand <input {...field('brand')} placeholder="e.g. Mahindra" required /></label>
              <label>Model <input {...field('model')} placeholder="e.g. 575 DI" required /></label>
            </div>
            <div className="row">
              <label>Year <input {...field('year')} type="number" min="1970" max={new Date().getFullYear()} required /></label>
              <label>Hours used <input {...field('hoursUsed')} type="number" min="0" /></label>
            </div>
            <div className="row">
              <label>Expected price (₹) <input {...field('expectedPrice')} type="number" min="0" step="1000" /></label>
              <label>Village / District <input {...field('location')} required /></label>
            </div>
            <label>
              Description
              <textarea {...field('description')} rows="3" placeholder="Condition, documents, reason for selling…" />
            </label>

            <PhotoSlots
              files={files}
              existing={existing}
              onPick={(angle, file) => setFiles((f) => ({ ...f, [angle]: file }))}
              onRemove={removePhoto}
              onRemoveExisting={(id) => setRemoved((ids) => [...ids, id])}
            />

            <PaperSlots
              files={papers}
              saved={editing?.verification.documents ?? null}
              onPick={(type, file) => setPapers((p) => ({ ...p, [type]: file }))}
              onClear={(type) => setPapers(({ [type]: _, ...rest }) => rest)}
            />

            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Checking…' : editing ? 'Save and check again' : 'Post and check'}
            </button>
            {editing && <button type="button" className="btn btn-light btn-block" onClick={resetForm}>Cancel editing</button>}
          </form>
        </div>

        <section>
          <h2>My posted tractors</h2>
          <p className="muted">Brokers see a listing once its photos and papers have been checked against the form.</p>
          <div className="grid">
            {tractors?.length === 0 && <p className="muted">You have not posted any tractor yet.</p>}
            {tractors?.map((t) => (
              <TractorCard key={t.id} tractor={t} onEdit={startEdit} onDelete={remove} onZoom={zoom}>
                <Verification tractor={t} onChange={replaceTractor} />
              </TractorCard>
            ))}
          </div>
        </section>
      </main>
      {lightbox}
      {progress && <CheckProgress steps={progress.steps} result={progress.result} onClose={() => setProgress(null)} />}
    </>
  );
}

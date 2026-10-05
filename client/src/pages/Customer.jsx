import { useCallback, useEffect, useRef, useState } from 'react';
import { api, shrinkPhoto } from '../api.js';
import { useRequireLogin } from '../auth.js';
import Header from '../components/Header.jsx';
import { useLightbox } from '../components/Lightbox.jsx';
import PhotoSlots from '../components/PhotoSlots.jsx';
import TractorCard from '../components/TractorCard.jsx';

const FIELDS = ['brand', 'model', 'year', 'hoursUsed', 'expectedPrice', 'location', 'description'];
const EMPTY = Object.fromEntries(FIELDS.map((name) => [name, '']));

export default function Customer() {
  const user = useRequireLogin('customer');
  const [lightbox, zoom] = useLightbox();
  const formRef = useRef(null);

  const [tractors, setTractors] = useState(null);
  const [details, setDetails] = useState(EMPTY);
  const [files, setFiles] = useState({}); // newly picked photos by angle
  const [editing, setEditing] = useState(null); // the tractor being edited, or null when posting a new one
  const [removed, setRemoved] = useState([]); // ids of saved photos removed while editing
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('/api/tractors/mine').then((data) => setTractors(data.tractors)), []);
  useEffect(() => {
    if (user) load().catch((err) => setError(err.message));
  }, [user, load]);

  // Saved photos still kept; a newly picked photo replaces the saved one for its angle when the form is sent.
  const existing = (editing?.photos ?? []).filter((p) => !removed.includes(p.id));

  function resetForm() {
    setDetails(EMPTY);
    setFiles({});
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

  async function submit(e) {
    e.preventDefault();
    const keptAngles = new Set(existing.map((p) => p.angle));
    const photoCount = existing.length + Object.keys(files).filter((angle) => !keptAngles.has(angle)).length;
    if (!photoCount) {
      setError('Add at least one photo of the tractor');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      for (const [name, value] of Object.entries(details)) body.set(name, value);
      for (const [angle, file] of Object.entries(files)) body.set(`photo_${angle}`, await shrinkPhoto(file));
      if (editing) {
        body.set('removePhotoIds', removed.join(','));
        await api(`/api/tractors/${editing.id}`, { method: 'PUT', body });
      } else {
        await api('/api/tractors', { method: 'POST', body });
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) return <Header />;

  const field = (name) => ({
    name,
    value: details[name],
    onChange: (e) => setDetails((d) => ({ ...d, [name]: e.target.value })),
  });

  return (
    <>
      <Header user={user} />
      <main className="wrap layout">
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

          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Uploading…' : editing ? 'Save changes' : 'Post tractor'}
          </button>
          {editing && <button type="button" className="btn btn-light btn-block" onClick={resetForm}>Cancel editing</button>}
        </form>

        <section>
          <h2>My posted tractors</h2>
          <div className="grid">
            {tractors?.length === 0 && <p className="muted">You have not posted any tractor yet.</p>}
            {tractors?.map((t) => <TractorCard key={t.id} tractor={t} onEdit={startEdit} onDelete={remove} onZoom={zoom} />)}
          </div>
        </section>
      </main>
      {lightbox}
    </>
  );
}

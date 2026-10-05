import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useRequireLogin } from '../auth.js';
import Header from '../components/Header.jsx';
import { useLightbox } from '../components/Lightbox.jsx';
import TractorCard from '../components/TractorCard.jsx';

export default function Broker() {
  const user = useRequireLogin('broker');
  const [lightbox, zoom] = useLightbox();
  const [query, setQuery] = useState('');
  const [tractors, setTractors] = useState(null);
  const [error, setError] = useState('');

  // Search after the broker stops typing for a moment.
  useEffect(() => {
    if (!user) return;
    let active = true;
    const timer = setTimeout(() => {
      api(`/api/tractors?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (!active) return;
          setTractors(data.tractors);
          setError('');
        })
        .catch((err) => active && setError(err.message));
    }, query ? 300 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [user, query]);

  if (!user) return <Header />;

  return (
    <>
      <Header user={user} />
      <main className="wrap">
        <div className="toolbar">
          <div>
            <h2 className="flush">Tractors posted by customers</h2>
            {tractors && <span className="muted">{tractors.length} tractor{tractors.length === 1 ? '' : 's'}</span>}
          </div>
          <input type="search" placeholder="Search brand, model or location…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="error">{error}</div>
        <div className="grid">
          {tractors?.length === 0 && <p className="muted">No tractors found.</p>}
          {tractors?.map((t) => <TractorCard key={t.id} tractor={t} showContact onZoom={zoom} />)}
        </div>
      </main>
      {lightbox}
    </>
  );
}

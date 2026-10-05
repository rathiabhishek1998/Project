import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { useRequireLogin } from '../auth.js';
import Header from '../components/Header.jsx';

/** "5 minutes ago", "2 days ago". */
function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The devices a customer or broker is logged in on, with buttons to log them out. */
export default function Account() {
  const user = useRequireLogin(null);
  const navigate = useNavigate();
  const [sessions, setSessions] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api('/api/auth/sessions').then((d) => setSessions(d.sessions)).catch((e) => setError(e.message)), []);
  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function logOut(session) {
    if (!session.current && !confirm(`Log out ${session.device}?`)) return;
    try {
      await api(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) return navigate('/');
      setMessage(`${session.device} was logged out.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function logOutOthers() {
    if (!confirm('Log out all other devices?')) return;
    try {
      const { ended } = await api('/api/auth/sessions', { method: 'DELETE' });
      setMessage(`${ended} other device${ended === 1 ? ' was' : 's were'} logged out.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!user) return <Header />;
  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <>
      <Header user={user} />
      <main className="wrap narrow-wide">
        <div className="card">
          <h2>Your account</h2>
          <p className="muted">{user.role === 'broker' ? 'Broker' : 'Customer'} · {user.name} · +91 {user.phone}</p>

          <h3>Where you’re logged in</h3>
          <p className="muted hint">
            Without “Keep me logged in”, you are logged out after 30 minutes without activity or when the browser closes.
            With it, after 7 days without activity (30 days at most).
          </p>
          {message && <div className="notice">{message}</div>}
          <div className="error">{error}</div>
          <ul className="sessions">
            {sessions?.map((s) => (
              <li key={s.id} className={s.current ? 'current' : ''}>
                <div>
                  <b>{s.device}</b> {s.current && <span className="tag">This device</span>}
                  <div className="muted hint">
                    Last active {s.current ? 'now' : ago(s.lastSeenAt)} · logged in {ago(s.createdAt)}
                    {s.remember ? ' · kept logged in' : ''}
                  </div>
                </div>
                <button className="btn btn-light" onClick={() => logOut(s)}>Log out</button>
              </li>
            ))}
          </ul>
          {others > 0 && (
            <button className="btn btn-danger btn-block" onClick={logOutOthers}>
              Log out all other devices ({others})
            </button>
          )}
        </div>
      </main>
    </>
  );
}

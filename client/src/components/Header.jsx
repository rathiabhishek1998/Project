import { Link, useNavigate } from 'react-router';
import { api } from '../api.js';

/** Site header. Pass the logged-in user to show their name and a log-out button. */
export default function Header({ user }) {
  const navigate = useNavigate();

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    navigate('/');
  }

  return (
    <header>
      <div className="wrap">
        <Link to="/">🚜 TractorBazaar</Link>
        {user && (
          <span>
            {user.role === 'broker' ? 'Broker' : 'Customer'}: {user.name} ·{' '}
            <button className="btn btn-light" onClick={logout}>Log out</button>
          </span>
        )}
      </div>
    </header>
  );
}

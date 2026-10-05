import { Link, useNavigate } from 'react-router';
import { api } from '../api.js';

/** Site header. Pass the logged-in user to show their name, a link to their account and a log-out button. */
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
          <span className="who">
            <Link to={`/${user.role}`} className="home-link">{user.role === 'broker' ? 'Broker' : 'Customer'}: {user.name}</Link>
            <Link to="/account" className="btn btn-light">Account</Link>
            <button className="btn btn-light" onClick={logout}>Log out</button>
          </span>
        )}
      </div>
    </header>
  );
}

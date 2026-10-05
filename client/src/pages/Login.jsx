import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { postJson } from '../api.js';
import { useRoleParam } from '../auth.js';
import Header from '../components/Header.jsx';

export default function Login() {
  const role = useRoleParam();
  const other = role === 'broker' ? 'customer' : 'broker';
  const navigate = useNavigate();
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await postJson('/api/auth/login', { phone: f.get('phone'), password: f.get('password'), role });
      navigate(`/${role}`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <Header />
      <main className="wrap narrow">
        <form className="card" onSubmit={submit}>
          <h2>{role === 'broker' ? 'Broker Login' : 'Customer Login'}</h2>
          <div className="error">{error}</div>
          <label>Mobile number <input name="phone" inputMode="numeric" maxLength={10} required autoFocus /></label>
          <label>Password <input name="password" type="password" required /></label>
          <button className="btn btn-primary btn-block">Log in</button>
          <p className="muted">New here? <Link to={`/register?role=${role}`}>Create an account</Link></p>
          <p className="muted"><Link to={`/login?role=${other}`}>Are you a {other}? Log in here</Link></p>
        </form>
      </main>
    </>
  );
}

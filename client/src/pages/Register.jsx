import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { postJson } from '../api.js';
import { useRoleParam } from '../auth.js';
import Header from '../components/Header.jsx';

export default function Register() {
  const role = useRoleParam();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await postJson('/api/auth/register', { name: f.get('name'), phone: f.get('phone'), password: f.get('password'), role });
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
          <h2>{role === 'broker' ? 'Broker Sign up' : 'Customer Sign up'}</h2>
          <div className="error">{error}</div>
          <label>Full name <input name="name" required autoFocus /></label>
          <label>Mobile number <input name="phone" inputMode="numeric" maxLength={10} required /></label>
          <label>Password <input name="password" type="password" minLength={6} required /></label>
          <button className="btn btn-primary btn-block">Create account</button>
          <p className="muted">Already have an account? <Link to={`/login?role=${role}`}>Log in</Link></p>
        </form>
      </main>
    </>
  );
}

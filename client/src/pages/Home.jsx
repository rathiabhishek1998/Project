import { Link } from 'react-router';
import Header from '../components/Header.jsx';

const CHOICES = [
  { role: 'customer', emoji: '👨‍🌾', title: "I'm a Customer", text: 'Post your tractor with photos', login: 'Customer Login' },
  { role: 'broker', emoji: '🤝', title: "I'm a Broker", text: 'Browse tractors posted by customers', login: 'Broker Login' },
];

export default function Home() {
  return (
    <>
      <Header />
      <main className="wrap">
        <div className="hero">
          <h1>Sell your used tractor to trusted brokers</h1>
          <p className="muted">Customers post photos of their tractor. Brokers see them and call you with an offer.</p>
        </div>
        <div className="choices">
          {CHOICES.map((c) => (
            <div className="card" key={c.role}>
              <div className="emoji">{c.emoji}</div>
              <h2>{c.title}</h2>
              <p className="muted">{c.text}</p>
              <Link className="btn btn-primary" to={`/login?role=${c.role}`}>{c.login}</Link>
              <Link className="btn btn-light" to={`/register?role=${c.role}`}>Sign up</Link>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}

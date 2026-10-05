import { useState } from 'react';
import { api } from '../api.js';

/** Broker asks a question about a tractor's papers or photos (any language) and gets an answer from them. */
export default function AskDocuments({ tractorId }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  async function ask(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api(`/api/tractors/${tractorId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      setAnswer(data.answer);
    } catch (err) {
      setAnswer(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="contact">
      <div className="listing-status ok">✓ Photos, RC, insurance and owner ID verified</div>
      <form className="chat-input" onSubmit={ask}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about the papers or photos, e.g. insurance valid till? tyres worn?" maxLength={500} />
        <button className="btn btn-light" disabled={busy || !question.trim()}>{busy ? '…' : 'Ask'}</button>
      </form>
      {answer && <p className="answer">{answer}</p>}
    </div>
  );
}

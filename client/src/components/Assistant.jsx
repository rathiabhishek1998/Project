import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const LANGUAGES = { 'mr-IN': 'मराठी', 'hi-IN': 'हिंदी', 'en-IN': 'English' };
const GREETING = 'नमस्कार! तुमच्या ट्रॅक्टरबद्दल सांगा — कंपनी, मॉडेल, वर्ष, गाव आणि अपेक्षित किंमत. मी फॉर्म भरतो. (You can also talk in English.)';
const MAX_MESSAGES = 39; // the server accepts 40; always send an odd number so the history starts with the customer

/** Reads the reply aloud in the chosen language, if the browser has a voice for it (Hindi voices read Marathi well). */
function speak(text, lang) {
  if (!window.speechSynthesis) return;
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === lang) ?? (lang === 'mr-IN' ? voices.find((v) => v.lang === 'hi-IN') : null);
  if (!voice) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/**
 * Chat (typed or spoken) that fills the listing form. form: the form's current values;
 * onFields(fields) receives the values the assistant worked out, in English.
 */
export default function Assistant({ form, onFields }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [lang, setLang] = useState('mr-IN');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recognition = useRef(null);
  const log = useRef(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);
  useEffect(() => () => recognition.current?.abort(), []);

  async function send(text, { spoken = false } = {}) {
    text = text.trim();
    if (!text || busy) return;
    const sent = [...messages, { role: 'user', content: text }];
    setMessages(sent);
    setInput('');
    setError('');
    setBusy(true);
    try {
      const { reply, fields } = await api('/api/assistant/form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: sent.slice(-MAX_MESSAGES), form: toApi(form) }),
      });
      setMessages([...sent, { role: 'assistant', content: reply }]);
      onFields(fields);
      if (spoken) speak(reply, lang);
    } catch (err) {
      setMessages(messages); // take the unanswered message back out, so the history stays user/assistant pairs
      setInput(text);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function listen() {
    if (listening) return recognition.current?.stop();
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    let heard = '';
    rec.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join(' ');
      setInput(heard);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') setError('Allow microphone access to talk to the assistant');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') setError('Could not hear that. Please try again or type');
    };
    rec.onend = () => {
      setListening(false);
      if (heard) send(heard, { spoken: true });
    };
    recognition.current = rec;
    setError('');
    setListening(true);
    rec.start();
  }

  return (
    <div className="assistant card">
      <div className="assistant-head">
        <strong>🤖 Fill the form by talking</strong>
        <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Speaking language">
          {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>
      <div className="chat-log" ref={log}>
        <p className="bubble bot">{GREETING}</p>
        {messages.map((m, i) => <p key={i} className={`bubble ${m.role === 'user' ? 'me' : 'bot'}`}>{m.content}</p>)}
        {busy && <p className="bubble bot typing">…</p>}
      </div>
      <div className="error">{error}</div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        {Recognition && (
          <button type="button" className={`btn mic${listening ? ' on' : ''}`} onClick={listen} disabled={busy}
            aria-label={listening ? 'Stop listening' : 'Speak'} title={listening ? 'Stop' : `Speak in ${LANGUAGES[lang]}`}>
            {listening ? '■' : '🎤'}
          </button>
        )}
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? 'Listening…' : 'Type or tap 🎤 to speak'} disabled={busy} />
        <button className="btn btn-primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}

/** The form as the API expects it: numbers as numbers, empty as null. */
function toApi(form) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const text = (v) => (v ? String(v) : null);
  return {
    brand: text(form.brand), model: text(form.model), year: num(form.year), hoursUsed: num(form.hoursUsed),
    expectedPrice: num(form.expectedPrice), location: text(form.location), description: text(form.description),
  };
}

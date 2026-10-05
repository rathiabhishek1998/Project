import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const LANGUAGES = { 'mr-IN': 'मराठी', 'hi-IN': 'हिंदी', 'en-IN': 'English' };
// Shown in the chosen language only, like every reply.
const GREETINGS = {
  'mr-IN': 'नमस्कार! तुमच्या ट्रॅक्टरबद्दल सांगा — कंपनी, मॉडेल, वर्ष, गाव आणि अपेक्षित किंमत. मी फॉर्म भरतो.',
  'hi-IN': 'नमस्ते! अपने ट्रैक्टर के बारे में बताइए — कंपनी, मॉडल, साल, गाँव और अपेक्षित कीमत। मैं फ़ॉर्म भर दूँगा।',
  'en-IN': 'Hello! Tell me about your tractor: brand, model, year, village and expected price. I will fill in the form.',
};
const MAX_MESSAGES = 39; // the server accepts 40; always send an odd number so the history starts with the customer

// The assistant always speaks with one voice. An Indian Hindi voice reads Marathi (same script), Hindi and
// English, so it is preferred; the voice picked is remembered on this device so it never changes between replies.
const VOICE_KEY = 'assistant-voice';
const VOICE_PREFERENCE = [
  (v) => v.lang === 'hi-IN' && /google/i.test(v.name),
  (v) => v.lang === 'hi-IN',
  (v) => v.lang === 'mr-IN',
  (v) => v.lang === 'en-IN',
];

function assistantVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return null; // not loaded yet
  let saved = null;
  try {
    saved = localStorage.getItem(VOICE_KEY);
  } catch {
    // storage blocked: pick the same way every time instead
  }
  const voice = voices.find((v) => v.name === saved) ?? VOICE_PREFERENCE.map((match) => voices.find(match)).find(Boolean);
  if (!voice) return null;
  try {
    localStorage.setItem(VOICE_KEY, voice.name);
  } catch {
    // fine, see above
  }
  return voice;
}

/** Reads a reply aloud in the assistant's one voice (skipped when no suitable voice can read it). */
function speak(text) {
  const voice = assistantVoice();
  if (!voice) return;
  if (voice.lang.startsWith('en') && /[\u0900-\u097F]/.test(text)) return; // an English-only voice can't read Devanagari
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 1;
  utterance.pitch = 1;
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
  // Browsers load their voices in the background; ask early so the voice is ready for the first reply.
  useEffect(() => {
    if (!window.speechSynthesis) return undefined;
    speechSynthesis.getVoices();
    const ready = () => assistantVoice();
    speechSynthesis.addEventListener('voiceschanged', ready);
    return () => speechSynthesis.removeEventListener('voiceschanged', ready);
  }, []);

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
      if (spoken) speak(reply);
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
        <p className="bubble bot">{GREETINGS[lang]}</p>
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

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, ENDED_REASONS, SESSION_ENDED } from './api.js';

/** The role in ?role=, defaulting to customer. */
export function useRoleParam() {
  const [params] = useSearchParams();
  return params.get('role') === 'broker' ? 'broker' : 'customer';
}

const ACTIVITY = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
const PING_EVERY = 5 * 60_000; // tell the server the user is active at most this often

/**
 * The logged-in user (null while loading). Sends anyone not logged in (as `role`, when given) to the login page.
 * While the page is open it also keeps the session's inactivity rule: using the page (typing a long form, say)
 * keeps the login alive, and after the session's idle time with no use at all it logs out and says why.
 */
export function useRequireLogin(role) {
  const [me, setMe] = useState(null);
  const navigate = useNavigate();
  const loginPage = `/login?role=${role ?? me?.user.role ?? 'customer'}`;

  useEffect(() => {
    let active = true;
    api('/api/auth/me')
      .then((data) => {
        if (role && data.user.role !== role) throw new Error('Wrong role');
        if (active) setMe(data);
      })
      .catch((err) => {
        const reason = ENDED_REASONS[err.code];
        if (active) navigate(`/login?role=${role ?? 'customer'}${reason ? `&ended=${reason}` : ''}`, { replace: true });
      });
    return () => {
      active = false;
    };
  }, [role, navigate]);

  useEffect(() => {
    if (!me) return undefined;
    const ended = (e) => navigate(`${loginPage}&ended=${e?.detail ?? 'idle'}`, { replace: true });
    let lastActivity = Date.now();
    let lastPing = Date.now();
    const onActivity = () => {
      lastActivity = Date.now();
      if (lastActivity - lastPing > PING_EVERY) {
        lastPing = lastActivity;
        api('/api/auth/me').catch(() => {}); // a failure here fires SESSION_ENDED if the login is over
      }
    };
    const timer = setInterval(() => {
      if (Date.now() - lastActivity < me.session.idleMs) return;
      clearInterval(timer);
      api('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(ended);
    }, 30_000);
    // Coming back to the tab (e.g. after the laptop slept) checks the login straight away.
    const onVisible = () => document.visibilityState === 'visible' && api('/api/auth/me').catch(() => {});
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { passive: true });
    window.addEventListener(SESSION_ENDED, ended);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      for (const e of ACTIVITY) window.removeEventListener(e, onActivity);
      window.removeEventListener(SESSION_ENDED, ended);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [me, navigate, loginPage]);

  return me?.user ?? null;
}

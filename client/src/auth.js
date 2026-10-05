import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from './api.js';

/** The role in ?role=, defaulting to customer. */
export function useRoleParam() {
  const [params] = useSearchParams();
  return params.get('role') === 'broker' ? 'broker' : 'customer';
}

/** The logged-in user (null while loading). Sends anyone not logged in as `role` to that role's login page. */
export function useRequireLogin(role) {
  const [user, setUser] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    api('/api/auth/me')
      .then(({ user }) => {
        if (user.role !== role) throw new Error('Wrong role');
        if (active) setUser(user);
      })
      .catch(() => active && navigate(`/login?role=${role}`, { replace: true }));
    return () => {
      active = false;
    };
  }, [role, navigate]);
  return user;
}

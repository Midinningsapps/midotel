'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Me } from '@/lib/api';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

/** Signed-in layout: loads the current user, redirects to /login when the session is missing. */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
      });
  }, [router]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  if (!me) return <div className="page muted">Loading…</div>;
  return (
    <MeContext.Provider value={me}>
      <header className="topbar">
        <Link href="/" className="brand">Midotel</Link>
        <span className="muted">{me.tenant?.name}</span>
        <span className="spacer" />
        <span className="muted">{me.user.name}</span>
        <button onClick={logout}>Sign out</button>
      </header>
      <main className="page">{children}</main>
    </MeContext.Provider>
  );
}

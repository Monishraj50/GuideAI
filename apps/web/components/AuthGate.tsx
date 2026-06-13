'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from './AuthProvider';

/**
 * Redirects to /signin while no connection exists. Skips the redirect on the
 * sign-in page itself, on healthz probes, and on API routes (handled at the
 * proxy layer separately).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { state, initialLoading } = useAuth();
  const pathname = usePathname() ?? '/';
  const router = useRouter();

  const isSignin = pathname.startsWith('/signin');

  useEffect(() => {
    if (initialLoading || !state) return;
    if (!state.authed && !isSignin) router.replace('/signin');
    if (state.authed && isSignin) router.replace('/');
  }, [initialLoading, state, isSignin, router]);

  if (initialLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center">
        <div className="text-dim text-sm">loading…</div>
      </div>
    );
  }
  if (state && !state.authed && !isSignin) {
    return null;
  }
  return <>{children}</>;
}

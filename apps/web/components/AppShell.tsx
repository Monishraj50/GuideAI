'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** Renders sidebar + top bar around the page, except on the sign-in screen
 *  where we want a clean full-bleed experience. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const bare = pathname.startsWith('/signin');

  if (bare) return <>{children}</>;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <main className="flex-1 min-h-0 flex flex-col">{children}</main>
      </div>
    </div>
  );
}

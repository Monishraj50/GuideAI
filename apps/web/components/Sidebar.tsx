'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  HomeIcon, RadioTower, Hash, Network, Store, ScrollText,
  Settings as SettingsIcon, Sparkles, FolderTree,
} from 'lucide-react';
import { Killswitch } from './Killswitch';
import { useWorkspaceId } from './WorkspaceProvider';
import { useAuth } from './AuthProvider';
import { cn } from '../lib/cn';

const TABS = [
  { href: '/',         label: 'Home',     hint: 'digest',      icon: HomeIcon },
  { href: '/projects', label: 'Projects', hint: 'all',         icon: FolderTree },
  { href: '/ops',      label: 'Ops',      hint: 'live feed',   icon: RadioTower },
  { href: '/channels', label: 'Channels', hint: 'team rooms',  icon: Hash },
  { href: '/org',      label: 'Org',      hint: 'roster',      icon: Network },
  { href: '/hire',     label: 'Hire',     hint: 'marketplace', icon: Store },
  { href: '/logs',     label: 'Logs',     hint: 'replay',      icon: ScrollText },
  { href: '/settings', label: 'Settings', hint: 'rules',       icon: SettingsIcon },
] as const;

export function Sidebar() {
  const pathname = usePathname() ?? '/';
  const workspaceId = useWorkspaceId();
  const { state: auth } = useAuth();
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <aside className="relative z-20 w-60 glass border-r border-line/70 flex flex-col text-sm shadow-soft">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-line/70">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-sonnet flex items-center justify-center shadow-glow">
          <Sparkles size={14} strokeWidth={2.4} className="text-bg" />
        </div>
        <div>
          <div className="text-ink font-semibold tracking-tight leading-tight">GuideAI</div>
          <div className="text-dim text-[10px] tracking-wide uppercase">your company HQ</div>
        </div>
      </div>
      <nav className="px-2 py-2 flex flex-col gap-0.5">
        {TABS.map((t) => {
          const active = isActive(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'group flex items-center gap-3 px-3 py-2 rounded-md transition-all duration-150 relative',
                active
                  ? 'bg-line2/60 text-ink shadow-soft'
                  : 'text-ink2 hover:bg-line/50 hover:text-ink',
              )}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent shadow-glow" />
              )}
              <Icon size={15} strokeWidth={1.8} className={active ? 'text-accent' : 'text-dim group-hover:text-ink'} />
              <span className="flex-1 truncate">{t.label}</span>
              <span className={cn(
                'text-[10px] uppercase tracking-wider',
                active ? 'text-dim2' : 'text-dim2 group-hover:text-dim',
              )}>
                {t.hint}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-2 pb-2 space-y-2">
        <Killswitch workspaceId={workspaceId} />
        {auth?.user && (
          <Link
            href="/settings"
            className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-line/60 hover:border-line2 hover:bg-line/30 transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent/60 to-sonnet/60 flex items-center justify-center text-bg text-[10px] font-semibold">
              {(auth.user.displayName ?? auth.user.username).slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-ink text-xs truncate">{auth.user.displayName ?? auth.user.username}</div>
              <div className="text-dim2 text-[10px]">
                {auth.user.isGuest ? 'guest mode' : '@' + auth.user.username}
              </div>
            </div>
          </Link>
        )}
      </div>
    </aside>
  );
}

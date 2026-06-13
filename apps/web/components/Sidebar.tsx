import Link from 'next/link';

const TABS = [
  { href: '/', label: 'Home', hint: 'digest' },
  { href: '/ops', label: 'Ops', hint: 'live feed' },
  { href: '/channels', label: 'Channels', hint: 'team rooms' },
  { href: '/org', label: 'Org', hint: 'roster' },
  { href: '/hire', label: 'Hire', hint: 'marketplace' },
  { href: '/logs', label: 'Logs', hint: 'replay' },
  { href: '/settings', label: 'Settings', hint: 'rules + budgets' },
] as const;

export function Sidebar() {
  return (
    <aside className="w-56 bg-surface border-r border-line p-3 flex flex-col gap-1 text-sm">
      <div className="px-2 py-3 mb-2 border-b border-line">
        <div className="text-ink font-semibold tracking-tight">GuideAI</div>
        <div className="text-dim text-xs">your company HQ</div>
      </div>
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="group flex items-center justify-between px-2 py-1.5 rounded hover:bg-line transition-colors"
        >
          <span className="text-ink">{t.label}</span>
          <span className="text-dim text-xs group-hover:text-ink">{t.hint}</span>
        </Link>
      ))}
      <div className="mt-auto px-2 py-2 border-t border-line text-xs text-dim">
        <div>workspace: <span className="text-ink">demo</span></div>
        <div>step 4 / 15</div>
      </div>
    </aside>
  );
}

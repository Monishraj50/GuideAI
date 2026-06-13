'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Play, RadioTower, Store, Network, Settings as SettingsIcon, ArrowRight } from 'lucide-react';
import { toast } from '../components/Toast';
import { cn } from '../lib/cn';

interface Digest {
  date: string | null;
  text: string | null;
  summary: { briefs: number; phasesCompleted: number; tokensIn: number; tokensOut: number } | null;
  generatedAt?: number;
}

export function Home({ workspaceId }: { workspaceId: string }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [busy, setBusy] = useState(false);
  const [greeting, setGreeting] = useState('Hello');

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/digest`);
    if (r.ok) setDigest(await r.json());
  }
  async function triggerNow() {
    setBusy(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/digest`, { method: 'POST' });
      if (!r.ok) throw new Error('failed');
      toast({ title: 'Digest generated', variant: 'success' });
      await refresh();
    } catch (e: any) { toast({ title: 'Digest failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    setGreeting(`Good ${timeOfDay()}`);
    refresh();
  }, []);

  return (
    <div className="overflow-y-auto">
      <div className="p-8 max-w-4xl">
        {/* Hero */}
        <div className="mb-8">
          <div className="text-dim2 text-[10px] uppercase tracking-[0.18em] mb-2">workspace · <span className="text-dim">{workspaceId}</span></div>
          <h1 className="text-3xl font-semibold tracking-tight bg-gradient-to-r from-ink via-ink to-dim bg-clip-text text-transparent">
            {greeting}, boss.
          </h1>
          <p className="text-dim mt-2 text-sm">Your team has been working. Here&apos;s the digest.</p>
        </div>

        {/* Digest card */}
        <section className="mb-8 rounded-xl border border-line/70 bg-surface2/60 overflow-hidden shadow-soft">
          <div className="flex items-center justify-between px-5 py-3 border-b border-line/70 bg-gradient-to-r from-line/30 via-transparent to-transparent">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/30 flex items-center justify-center">
                <Sparkles size={14} className="text-accent" />
              </div>
              <div>
                <div className="text-ink text-sm font-medium">Daily standup digest</div>
                <div className="text-dim2 text-[11px]">
                  {digest?.generatedAt ? `Generated ${new Date(digest.generatedAt).toLocaleString()}` : 'Not generated yet'}
                </div>
              </div>
            </div>
            <button
              onClick={triggerNow}
              disabled={busy}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                'bg-accent text-bg hover:brightness-110 shadow-glow disabled:opacity-40',
              )}
            >
              <Play size={12} /> {busy ? 'running…' : 'run now'}
            </button>
          </div>
          <div className="px-5 py-4">
            {!digest?.date && (
              <div className="text-dim text-sm italic">No digest yet. Click <span className="text-ink">run now</span> to generate one for the last 24h.</div>
            )}
            {digest?.date && (
              <pre className="whitespace-pre-wrap font-mono text-[12.5px] text-ink2 leading-relaxed">{digest.text}</pre>
            )}
          </div>
        </section>

        {/* Quick links */}
        <section>
          <div className="text-dim2 text-[10px] uppercase tracking-wider mb-3">Quick links</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <QuickCard href="/ops" icon={RadioTower} label="Ops" hint="live feed · brief · approvals" />
            <QuickCard href="/hire" icon={Store} label="Hire" hint="154-agent marketplace" />
            <QuickCard href="/org" icon={Network} label="Org" hint="roster · metrics" />
            <QuickCard href="/settings" icon={SettingsIcon} label="Settings" hint="rules · audit" />
          </div>
        </section>
      </div>
    </div>
  );
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 5) return 'evening';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function QuickCard({ href, icon: Icon, label, hint }: { href: string; icon: React.ComponentType<{ size?: number }>; label: string; hint: string }) {
  return (
    <a href={href} className="group flex items-center gap-3 p-3 rounded-lg border border-line/70 bg-surface2/50 hover:border-line2 hover:bg-surface2 transition-all">
      <div className="w-8 h-8 rounded-md bg-line/40 border border-line/70 flex items-center justify-center text-dim group-hover:text-accent group-hover:border-accent/30 transition-colors">
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-ink text-sm">{label}</div>
        <div className="text-dim2 text-[11px] truncate">{hint}</div>
      </div>
      <ArrowRight size={12} className="text-dim2 group-hover:text-accent transition-colors" />
    </a>
  );
}

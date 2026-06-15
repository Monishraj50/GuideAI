'use client';

import { useEffect, useState } from 'react';
import { Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

interface OpenAIState { ready: boolean; apiKeyHint?: string }

export function SecondOpinionToggle({ workspaceId }: { workspaceId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [oai, setOai] = useState<OpenAIState | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/second-opinion`).then((r) => r.json()),
        fetch('/api/integrations/openai').then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setEnabled(!!a.enabled);
      setOai(b);
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [workspaceId]);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    try {
      const next = !enabled;
      const r = await fetch(`/api/workspaces/${workspaceId}/second-opinion`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await r.json();
      setEnabled(!!j.enabled);
      toast({ title: next ? 'Cross-vendor review on' : 'Cross-vendor review off', variant: next ? 'success' : 'warn' });
    } catch (e: any) { toast({ title: 'Toggle failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(false); }
  }

  if (enabled === null) return null;

  const keyOk = !!oai?.ready;
  const fullyArmed = enabled && keyOk;

  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border px-3 py-2 text-[12px]',
      fullyArmed ? 'border-accent/40 bg-accent/[0.06] shadow-glow' : enabled ? 'border-warn/40 bg-warn/[0.06]' : 'border-line/70 bg-surface2/40',
    )}>
      <Sparkles size={13} className={fullyArmed ? 'text-accent' : enabled ? 'text-warn' : 'text-dim'} />
      <div className="flex-1 min-w-0">
        <div className="text-ink font-medium">Cross-vendor review</div>
        <div className="text-dim2 text-[11px]">
          When ON, security-tagged briefs mix one OpenAI attempt into pass@k review.
          {enabled && !keyOk && (
            <span className="text-warn"> · no OpenAI key on file (mock will be used)</span>
          )}
          {!enabled && (
            <span> · off — review uses Claude attempts only</span>
          )}
          {fullyArmed && (
            <span className="text-accent"> · {oai?.apiKeyHint}</span>
          )}
        </div>
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={cn(
          'relative w-10 h-5 rounded-full transition-colors',
          enabled ? 'bg-accent' : 'bg-line/70',
          busy && 'opacity-50',
        )}
        title={enabled ? 'Disable cross-vendor review' : 'Enable cross-vendor review'}
      >
        <span className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-bg shadow-soft transition-all',
          enabled ? 'left-[22px]' : 'left-0.5',
        )} />
      </button>
    </div>
  );
}

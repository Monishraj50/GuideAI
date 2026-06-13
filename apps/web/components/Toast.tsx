'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { cn } from '../lib/cn';

type Variant = 'success' | 'warn' | 'error' | 'info';
export interface ToastInput { title: string; description?: string; variant?: Variant; ttl?: number }
interface InternalToast extends Required<Omit<ToastInput, 'description' | 'ttl'>> {
  id: number; description?: string; ttl: number;
}

const ICONS: Record<Variant, React.ComponentType<{ size?: number }>> = {
  success: CheckCircle2, warn: AlertTriangle, error: XCircle, info: Info,
};
const COLORS: Record<Variant, string> = {
  success: 'border-accent/50 text-accent bg-accent/[0.06]',
  warn:    'border-warn/50 text-warn bg-warn/[0.06]',
  error:   'border-err/50 text-err bg-err/[0.06]',
  info:    'border-info/50 text-info bg-info/[0.06]',
};

let nextId = 1;

export function toast(input: ToastInput) {
  window.dispatchEvent(new CustomEvent<ToastInput>('guideai:toast', { detail: input }));
}

export function ToastHost() {
  const [toasts, setToasts] = useState<InternalToast[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<ToastInput>;
      const t: InternalToast = {
        id: nextId++,
        title: ce.detail.title,
        description: ce.detail.description,
        variant: ce.detail.variant ?? 'info',
        ttl: ce.detail.ttl ?? 4000,
      };
      setToasts((prev) => [...prev, t]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), t.ttl);
    };
    window.addEventListener('guideai:toast', handler);
    return () => window.removeEventListener('guideai:toast', handler);
  }, []);

  function dismiss(id: number) { setToasts((p) => p.filter((t) => t.id !== id)); }

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2 w-80">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto animate-slideUp rounded-lg border bg-surface2/95 shadow-soft px-3 py-2 flex gap-2',
              COLORS[t.variant],
            )}
          >
            <Icon size={16} />
            <div className="flex-1 min-w-0">
              <div className="text-ink text-sm font-medium leading-snug">{t.title}</div>
              {t.description && <div className="text-dim text-xs mt-0.5 truncate">{t.description}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-dim hover:text-ink"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

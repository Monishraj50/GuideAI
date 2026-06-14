'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Package, FileText, BookOpen, Link as LinkIcon, Paperclip, Presentation,
  X, ChevronLeft, ChevronRight, Plus, RefreshCw, ExternalLink, Trash2, Sparkles,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type Kind = 'artifact' | 'slide-deck' | 'explainer' | 'link' | 'file';

interface Deliverable {
  id: string;
  workspaceId: string;
  briefId: string | null;
  kind: Kind;
  title: string;
  body: string | null;
  uri: string | null;
  source: 'auto' | 'manual';
  phase: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  createdAt: number;
}

const KIND_META: Record<Kind, { label: string; icon: React.ComponentType<{ size?: number; className?: string }>; tint: string }> = {
  'slide-deck': { label: 'Slide decks', icon: Presentation, tint: 'text-accent border-accent/40' },
  'explainer':  { label: 'Explainers',  icon: BookOpen,     tint: 'text-info border-info/40' },
  'artifact':   { label: 'Phase artifacts', icon: FileText, tint: 'text-warn border-warn/40' },
  'link':       { label: 'Links',       icon: LinkIcon,     tint: 'text-dim border-line/70' },
  'file':       { label: 'Files',       icon: Paperclip,    tint: 'text-dim border-line/70' },
};

const KIND_ORDER: Kind[] = ['slide-deck', 'explainer', 'artifact', 'link', 'file'];

function fmtTs(ms: number) {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function Deliverables({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<Deliverable[]>([]);
  const [open, setOpen] = useState<Deliverable | null>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<{ kind: 'link' | 'file'; title: string; uri: string; briefId: string }>({
    kind: 'link', title: '', uri: '', briefId: '',
  });

  async function refresh() {
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/deliverables`);
      if (r.ok) {
        const j = await r.json();
        setItems(j.items ?? []);
      }
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [workspaceId]);

  const grouped = useMemo(() => {
    const out: Record<Kind, Deliverable[]> = { 'slide-deck': [], explainer: [], artifact: [], link: [], file: [] };
    for (const it of items) out[it.kind]?.push(it);
    return out;
  }, [items]);

  async function destroy(id: string) {
    if (!confirm('Delete this deliverable?')) return;
    setItems((cur) => cur.filter((x) => x.id !== id));
    if (open?.id === id) setOpen(null);
    try {
      const r = await fetch(`/api/deliverables/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
    } catch { refresh(); }
  }

  async function regen(briefId: string) {
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/briefs/${briefId}/deliverables/regenerate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'regen failed');
      toast({
        title: 'Deliverables regenerated',
        description: `${j.artifacts} artifacts · ${j.deck ? 'deck' : 'no deck'} · ${j.explainer ? 'explainer' : 'no explainer'}`,
        variant: 'success',
      });
      await refresh();
    } catch (e: any) {
      toast({ title: 'Regen failed', description: e?.message, variant: 'error' });
    }
  }

  async function submitAdd() {
    if (!draft.title.trim() || !draft.uri.trim()) return;
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/deliverables`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: draft.kind, title: draft.title, uri: draft.uri,
          briefId: draft.briefId.trim() || null,
        }),
      });
      if (!r.ok) throw new Error();
      setDraft({ kind: 'link', title: '', uri: '', briefId: '' });
      setAddOpen(false);
      toast({ title: 'Added', variant: 'success' });
      await refresh();
    } catch {
      toast({ title: 'Add failed', variant: 'error' });
    }
  }

  // Brief IDs across items (so the regen button can act per brief)
  const briefIds = useMemo(() => Array.from(new Set(items.map((i) => i.briefId).filter(Boolean))) as string[], [items]);

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Deliverables"
        icon={<Package size={14} className="text-accent" />}
        right={
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="text-dim2 hover:text-ink text-xs flex items-center gap-1">
              <RefreshCw size={11} /> refresh
            </button>
            <button
              onClick={() => setAddOpen((x) => !x)}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-line/70 text-ink2 hover:text-ink hover:border-line2 text-xs"
            >
              <Plus size={11} /> add link / file
            </button>
          </div>
        }
      />

      {/* Per-brief regen buttons */}
      {briefIds.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-dim2 uppercase tracking-wider text-[10px]">regenerate:</span>
          {briefIds.map((b) => (
            <button
              key={b}
              onClick={() => regen(b)}
              className="font-mono px-1.5 py-0.5 rounded border border-line/70 text-dim2 hover:text-ink hover:border-line2"
              title={`Regenerate artifacts + deck + explainer for ${b}`}
            >
              <Sparkles size={9} className="inline mr-0.5" />{b}
            </button>
          ))}
        </div>
      )}

      {/* Manual add panel */}
      {addOpen && (
        <div className="border border-accent/40 rounded-lg bg-surface2/60 p-3 shadow-glow">
          <div className="grid md:grid-cols-4 gap-2 mb-2">
            <div>
              <Label>Kind</Label>
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'link' | 'file' })}
                className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
              >
                <option value="link">link</option>
                <option value="file">file</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>Title</Label>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Deployed staging URL"
                className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
              />
            </div>
            <div>
              <Label>Brief ID (optional)</Label>
              <input
                value={draft.briefId}
                onChange={(e) => setDraft({ ...draft, briefId: e.target.value })}
                placeholder="brief-…"
                className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
              />
            </div>
          </div>
          <div className="mb-2">
            <Label>{draft.kind === 'link' ? 'URL' : 'File path'}</Label>
            <input
              value={draft.uri}
              onChange={(e) => setDraft({ ...draft, uri: e.target.value })}
              placeholder={draft.kind === 'link' ? 'https://…' : '/path/to/file'}
              className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAddOpen(false)} className="text-dim2 hover:text-ink text-xs">cancel</button>
            <button
              onClick={submitAdd}
              disabled={!draft.title.trim() || !draft.uri.trim()}
              className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
            >
              <Plus size={11} /> add
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="border border-dashed border-line/70 rounded-lg p-4 text-dim2 text-xs italic">
          No deliverables yet. They appear automatically when a brief completes — phase artifacts, a slide deck, and a plain-English explainer.
        </div>
      ) : (
        <div className="space-y-4">
          {KIND_ORDER.map((k) => {
            const xs = grouped[k];
            if (!xs?.length) return null;
            const meta = KIND_META[k];
            const Icon = meta.icon;
            return (
              <div key={k}>
                <div className={cn('flex items-center gap-1.5 mb-2 text-[10px] uppercase tracking-wider font-medium', meta.tint.split(' ')[0])}>
                  <Icon size={11} />
                  <span>{meta.label}</span>
                  <span className="ml-1 font-mono">{xs.length}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {xs.map((d) => (
                    <DeliverableCard
                      key={d.id} d={d}
                      onOpen={() => { setOpen(d); setSlideIdx(0); }}
                      onDelete={() => destroy(d.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <DeliverableViewer
          d={open}
          slideIdx={slideIdx}
          setSlideIdx={setSlideIdx}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function DeliverableCard({ d, onOpen, onDelete }: { d: Deliverable; onOpen: () => void; onDelete: () => void }) {
  const meta = KIND_META[d.kind];
  const Icon = meta.icon;
  const slideCount = d.kind === 'slide-deck' && d.body ? d.body.split(/\n---\n/).length : null;
  return (
    <div className={cn('group rounded-md border bg-surface2/40 p-3 hover:border-line2 transition-colors', meta.tint)}>
      <div className="flex items-start gap-2">
        <Icon size={13} className={meta.tint.split(' ')[0]} />
        <div className="flex-1 min-w-0">
          <div className="text-ink text-[13px] font-medium truncate">{d.title}</div>
          <div className="text-dim2 text-[10px] flex items-center gap-2 mt-0.5 font-mono">
            <span>{d.briefId ?? '(no brief)'}</span>
            <span>·</span>
            <span>{fmtTs(d.createdAt)}</span>
            <span className="ml-auto">{d.source}</span>
          </div>
          {d.kind === 'slide-deck' && slideCount && (
            <div className="text-dim text-[11px] mt-1">{slideCount} slide{slideCount === 1 ? '' : 's'}</div>
          )}
          {d.kind === 'explainer' && d.body && (
            <div className="text-dim text-[11px] mt-1 line-clamp-2">{d.body.replace(/[#*_`>]/g, '').slice(0, 140)}…</div>
          )}
          {d.kind === 'artifact' && d.phase && (
            <div className="text-dim2 text-[10px] mt-1 font-mono uppercase tracking-wider">{d.phase}</div>
          )}
          {(d.kind === 'link' || d.kind === 'file') && d.uri && (
            <div className="text-dim text-[11px] mt-1 font-mono truncate" title={d.uri}>{d.uri}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button onClick={onOpen} className="text-accent hover:underline text-[11px]">open</button>
        {(d.kind === 'link' && d.uri) && (
          <a href={d.uri} target="_blank" rel="noreferrer" className="text-accent hover:underline text-[11px] flex items-center gap-0.5">
            visit <ExternalLink size={9} />
          </a>
        )}
        <button onClick={onDelete} className="ml-auto text-dim2 hover:text-err opacity-0 group-hover:opacity-100 transition-opacity">
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

function DeliverableViewer({ d, slideIdx, setSlideIdx, onClose }: { d: Deliverable; slideIdx: number; setSlideIdx: (n: number) => void; onClose: () => void }) {
  const slides = useMemo(
    () => (d.kind === 'slide-deck' && d.body ? d.body.split(/\n---\n/).map((s) => s.trim()).filter(Boolean) : []),
    [d],
  );
  // Bound the index even after deck shrinks on regenerate.
  useEffect(() => { if (slideIdx >= slides.length) setSlideIdx(0); }, [slides.length, slideIdx, setSlideIdx]);
  // Keyboard nav.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (d.kind !== 'slide-deck') return;
      if (e.key === 'ArrowLeft')  setSlideIdx(Math.max(0, slideIdx - 1));
      if (e.key === 'ArrowRight') setSlideIdx(Math.min(slides.length - 1, slideIdx + 1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slideIdx, slides.length, d.kind, onClose, setSlideIdx]);

  const isDeck = d.kind === 'slide-deck' && slides.length > 0;
  const meta = KIND_META[d.kind];
  const Icon = meta.icon;

  return (
    <div className="fixed inset-0 z-50 bg-bg/90 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line/70 rounded-xl shadow-glow max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-line/70">
          <Icon size={14} className={meta.tint.split(' ')[0]} />
          <span className="text-ink font-medium text-sm">{d.title}</span>
          {isDeck && <span className="text-dim2 text-[11px] font-mono ml-2">{slideIdx + 1} / {slides.length}</span>}
          <button onClick={onClose} className="ml-auto text-dim2 hover:text-ink"><X size={14} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 prose-content">
          {isDeck ? (
            <Markdown md={slides[slideIdx] ?? ''} large />
          ) : d.body ? (
            <Markdown md={d.body} />
          ) : d.uri ? (
            <div className="font-mono text-ink2 text-sm">{d.uri}</div>
          ) : (
            <div className="text-dim italic">(no content)</div>
          )}
        </div>

        {isDeck && (
          <footer className="flex items-center justify-between gap-2 px-4 py-2 border-t border-line/70 bg-bg/40">
            <button
              onClick={() => setSlideIdx(Math.max(0, slideIdx - 1))}
              disabled={slideIdx === 0}
              className="flex items-center gap-1 px-2 py-1 rounded border border-line/70 text-ink2 text-xs hover:border-line2 hover:text-ink disabled:opacity-40"
            >
              <ChevronLeft size={11} /> prev
            </button>
            <span className="text-dim2 text-[10px]">← → to navigate · esc to close</span>
            <button
              onClick={() => setSlideIdx(Math.min(slides.length - 1, slideIdx + 1))}
              disabled={slideIdx === slides.length - 1}
              className="flex items-center gap-1 px-2 py-1 rounded border border-line/70 text-ink2 text-xs hover:border-line2 hover:text-ink disabled:opacity-40"
            >
              next <ChevronRight size={11} />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

// Tiny markdown renderer: enough for ## headings, lists, bold/italic/code, paragraphs.
function Markdown({ md, large }: { md: string; large?: boolean }) {
  const lines = md.split('\n');
  const blocks: { kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul'; text?: string; items?: string[] }[] = [];
  let bullets: string[] = [];
  function flushBullets() { if (bullets.length) { blocks.push({ kind: 'ul', items: bullets }); bullets = []; } }
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flushBullets(); continue; }
    if (l.startsWith('# '))      { flushBullets(); blocks.push({ kind: 'h1', text: l.slice(2) }); continue; }
    if (l.startsWith('## '))     { flushBullets(); blocks.push({ kind: 'h2', text: l.slice(3) }); continue; }
    if (l.startsWith('### '))    { flushBullets(); blocks.push({ kind: 'h3', text: l.slice(4) }); continue; }
    if (/^[-*]\s+/.test(l))      { bullets.push(l.replace(/^[-*]\s+/, '')); continue; }
    flushBullets(); blocks.push({ kind: 'p', text: l });
  }
  flushBullets();

  return (
    <div className={cn('space-y-3', large && 'space-y-4')}>
      {blocks.map((b, i) => {
        if (b.kind === 'h1') return <h1 key={i} className={cn('text-ink font-semibold tracking-tight', large ? 'text-2xl' : 'text-xl')}>{inline(b.text!)}</h1>;
        if (b.kind === 'h2') return <h2 key={i} className={cn('text-ink font-semibold tracking-tight', large ? 'text-xl' : 'text-lg')}>{inline(b.text!)}</h2>;
        if (b.kind === 'h3') return <h3 key={i} className="text-ink2 font-medium">{inline(b.text!)}</h3>;
        if (b.kind === 'p')  return <p key={i} className={cn('text-ink2 leading-relaxed', large ? 'text-base' : 'text-sm')}>{inline(b.text!)}</p>;
        if (b.kind === 'ul') return <ul key={i} className={cn('list-disc list-inside text-ink2 space-y-1 marker:text-accent', large ? 'text-base leading-relaxed' : 'text-sm')}>
          {b.items!.map((it, j) => <li key={j}>{inline(it)}</li>)}
        </ul>;
        return null;
      })}
    </div>
  );
}
function inline(text: string): React.ReactNode[] {
  // very small subset: **bold**, _italic_, `code`
  const parts: React.ReactNode[] = [];
  let buf = ''; let i = 0;
  function flush() { if (buf) { parts.push(buf); buf = ''; } }
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > 0) { flush(); parts.push(<strong key={i} className="text-ink">{text.slice(i + 2, end)}</strong>); i = end + 2; continue; }
    }
    if (text.startsWith('`', i)) {
      const end = text.indexOf('`', i + 1);
      if (end > 0) { flush(); parts.push(<code key={i} className="font-mono text-accent bg-line/30 px-1 py-0.5 rounded text-[0.95em]">{text.slice(i + 1, end)}</code>); i = end + 1; continue; }
    }
    if (text.startsWith('_', i) && /\w/.test(text[i + 1] ?? '')) {
      const end = text.indexOf('_', i + 1);
      if (end > 0 && /\w/.test(text[end - 1] ?? '')) { flush(); parts.push(<em key={i} className="text-ink2">{text.slice(i + 1, end)}</em>); i = end + 1; continue; }
    }
    buf += text[i]; i++;
  }
  flush();
  return parts;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-dim2 text-[10px] uppercase tracking-wider mb-0.5">{children}</div>;
}
function SectionHeader({ title, icon, right }: { title: string; icon: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-ink font-medium text-sm">{title}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

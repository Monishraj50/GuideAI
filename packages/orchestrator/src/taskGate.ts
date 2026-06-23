// Per-phase release gate for Manual/Auto execution modes.
//
// In Auto mode (the default), every gate auto-releases the moment it is awaited
// — the orchestrator runs end-to-end with no pauses.
//
// In Manual mode, the orchestrator awaits an explicit release() call per
// (briefId, phase) before dispatching that phase's agent. The Kanban webview
// triggers releases when the user drags a card from Inactive → Active.
//
// In-memory only; state lives for the lifetime of the server process. If the
// server restarts mid-brief, the active brief is treated as paused — the
// Kanban can re-release any pending phase.

type GateKey = string; // `${briefId}::${phase}`

interface Gate {
  released: boolean;
  resolve?: () => void;
  promise: Promise<void>;
}

const gates: Map<GateKey, Gate> = new Map();
const briefModes: Map<string, 'auto' | 'manual'> = new Map();

function keyOf(briefId: string, phase: string): GateKey {
  return `${briefId}::${phase}`;
}

function ensureGate(key: GateKey): Gate {
  let g = gates.get(key);
  if (!g) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    g = { released: false, resolve, promise };
    gates.set(key, g);
  }
  return g;
}

/** Record the execution mode for a brief. Call from submitBrief() before any
 *  phase starts so awaitRelease can short-circuit in Auto mode. */
export function registerBrief(briefId: string, mode: 'auto' | 'manual'): void {
  briefModes.set(briefId, mode);
}

/** Read the recorded mode. Defaults to 'auto' if a brief was never registered
 *  (so existing code paths keep their current behavior). */
export function modeOf(briefId: string): 'auto' | 'manual' {
  return briefModes.get(briefId) ?? 'auto';
}

/** Block until the gate for (briefId, phase) is released. In Auto mode,
 *  resolves on the next microtask. */
export async function awaitRelease(briefId: string, phase: string): Promise<void> {
  const mode = modeOf(briefId);
  if (mode === 'auto') return;
  const g = ensureGate(keyOf(briefId, phase));
  if (g.released) return;
  await g.promise;
}

/** Explicitly release a phase gate. Safe to call multiple times. */
export function release(briefId: string, phase: string): boolean {
  const g = ensureGate(keyOf(briefId, phase));
  if (g.released) return false;
  g.released = true;
  g.resolve?.();
  return true;
}

/** Release every gate for a brief (used by "play all" in Manual mode and on
 *  cleanup). */
export function releaseAll(briefId: string): number {
  let n = 0;
  for (const [k, g] of gates.entries()) {
    if (k.startsWith(`${briefId}::`) && !g.released) {
      g.released = true;
      g.resolve?.();
      n++;
    }
  }
  return n;
}

/** Read gate states for a brief — used by the Kanban to render Inactive vs.
 *  released cards before any phase has started running. */
export function gateStates(briefId: string): Array<{ phase: string; released: boolean }> {
  const out: Array<{ phase: string; released: boolean }> = [];
  for (const [k, g] of gates.entries()) {
    if (k.startsWith(`${briefId}::`)) {
      const phase = k.slice(briefId.length + 2);
      out.push({ phase, released: g.released });
    }
  }
  return out;
}

/** Forget all gates for a brief — call when the brief is done or cancelled. */
export function disposeBrief(briefId: string): void {
  for (const k of Array.from(gates.keys())) {
    if (k.startsWith(`${briefId}::`)) gates.delete(k);
  }
  briefModes.delete(briefId);
}

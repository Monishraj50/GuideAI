// Per-phase release gate for Pending/Auto/Manual execution modes.
//
// Three modes the orchestrator honors:
//   - 'pending': brief is registered but the pipeline blocks at a synthetic
//                `_start_` gate. Calling start(briefId, mode) flips the mode
//                + releases that gate (Phase C — defer-dispatch flow).
//   - 'auto':    every gate resolves on the next microtask — pipeline runs
//                end-to-end with no pauses.
//   - 'manual':  orchestrator awaits an explicit release() per (briefId,phase)
//                gate. The Kanban webview triggers releases when the user
//                drags a card from Inactive → Active.
//
// In-memory only; state lives for the lifetime of the server process. If the
// server restarts mid-brief, the brief is treated as paused — the UI can
// re-release any pending gate via the public endpoints.
//
// Synthetic `_start_` gate is reserved — phases.ts awaits it before the
// PHASE_ORDER loop begins, so a 'pending' brief sits idle until start() runs.

type GateKey = string; // `${briefId}::${phase}`

export type BriefMode = 'pending' | 'auto' | 'manual';

/** Reserved gate name awaited at the very top of runPipeline. Released by
 *  start() once the user clicks "Start Implementing" and picks Auto or Manual. */
export const START_GATE = '_start_';

interface Gate {
  released: boolean;
  resolve?: () => void;
  promise: Promise<void>;
}

const gates: Map<GateKey, Gate> = new Map();
const briefModes: Map<string, BriefMode> = new Map();

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
 *  phase starts. 'pending' means the pipeline blocks at the start gate until
 *  start(briefId, mode) is called. */
export function registerBrief(briefId: string, mode: BriefMode): void {
  briefModes.set(briefId, mode);
}

/** Read the recorded mode. Defaults to 'auto' if a brief was never registered
 *  (so existing code paths keep their current behavior). */
export function modeOf(briefId: string): BriefMode {
  return briefModes.get(briefId) ?? 'auto';
}

/** Block until the gate for (briefId, phase) is released.
 *
 *  - 'auto'    → resolves immediately
 *  - 'manual'  → awaits explicit release() unless already released
 *  - 'pending' → also awaits, regardless of which phase — keeps everything
 *                gated until the user clicks Start Implementing
 */
export async function awaitRelease(briefId: string, phase: string): Promise<void> {
  const mode = modeOf(briefId);
  if (mode === 'auto') return;
  const g = ensureGate(keyOf(briefId, phase));
  if (g.released) return;
  await g.promise;
}

/** Explicitly release a single phase gate. Safe to call multiple times. */
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

/** Phase C — transition a 'pending' brief into either 'auto' (runs end-to-end)
 *  or 'manual' (runs phase-by-phase via drag-release on the Kanban). Always
 *  releases the synthetic start gate so runPipeline can proceed.
 *
 *  Returns the released gate count (so callers can log it). Safe to call on a
 *  brief that's already started — it just no-ops on the gates that are
 *  already released. */
export function start(briefId: string, mode: 'auto' | 'manual'): { mode: 'auto' | 'manual'; released: number } {
  briefModes.set(briefId, mode);
  const startReleased = release(briefId, START_GATE);
  let released = startReleased ? 1 : 0;
  if (mode === 'auto') {
    // Auto mode pre-releases everything so phase gates created later by
    // awaitRelease() also resolve instantly.
    released += releaseAll(briefId);
  }
  return { mode, released };
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

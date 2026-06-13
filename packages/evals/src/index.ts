// pass@k checkpoint runner.
//
// k is "how many independent attempts". An attempt "passes" if the closure
// returns a non-null result and the text length is above MIN_LEN. Aggregate
// verdict is "passed" iff at least `requireAgreement` of k attempts pass.
//
// For v1 the pass predicate is intentionally loose — semantic agreement is the
// judge-panel pattern (step beyond v1). The build log records this limitation.

export interface AttemptResult {
  index: number;
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  passed: boolean;
}

export interface PassKResult<T> {
  k: number;
  requireAgreement: number;
  attempts: AttemptResult[];
  passes: number;
  verdict: 'pass' | 'fail';
  /** The canonical attempt (longest passing, or longest overall). */
  canonical: AttemptResult;
  /** Anything the caller wants to thread through (e.g. the underlying chunks). */
  passthroughs: T[];
}

const MIN_LEN_DEFAULT = 30;

export interface RunPassKArgs<T> {
  k: number;
  requireAgreement: number;
  /** Required: closure that runs one attempt and returns its text + an opaque
   *  passthrough (e.g. all the raw chunks emitted during the attempt). */
  attempt: (index: number) => Promise<{ text: string; tokensIn: number; tokensOut: number; durationMs: number; passthrough: T }>;
  /** Override the per-attempt "passed" predicate. */
  predicate?: (text: string) => boolean;
  /** Sequential vs parallel execution. Parallel for speed; sequential for rate-limit safety. */
  parallel?: boolean;
}

export async function runPassK<T>(args: RunPassKArgs<T>): Promise<PassKResult<T>> {
  const { k, requireAgreement, attempt, parallel = true } = args;
  const predicate = args.predicate ?? ((t: string) => t.trim().length >= MIN_LEN_DEFAULT);

  const runOne = async (i: number): Promise<{ attempt: AttemptResult; passthrough: T }> => {
    const r = await attempt(i);
    return {
      attempt: {
        index: i,
        text: r.text,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        durationMs: r.durationMs,
        passed: predicate(r.text),
      },
      passthrough: r.passthrough,
    };
  };

  let rows;
  if (parallel) {
    rows = await Promise.all(Array.from({ length: k }, (_, i) => runOne(i)));
  } else {
    rows = [];
    for (let i = 0; i < k; i++) rows.push(await runOne(i));
  }

  const attempts = rows.map((r) => r.attempt);
  const passthroughs = rows.map((r) => r.passthrough);
  const passes = attempts.filter((a) => a.passed).length;
  const verdict: 'pass' | 'fail' = passes >= requireAgreement ? 'pass' : 'fail';

  // Pick canonical: longest passing attempt; fallback to longest overall.
  const passing = attempts.filter((a) => a.passed);
  const pool = passing.length > 0 ? passing : attempts;
  const canonical = pool.reduce((best, a) => a.text.length > best.text.length ? a : best, pool[0]!);

  return { k, requireAgreement, attempts, passes, verdict, canonical, passthroughs };
}

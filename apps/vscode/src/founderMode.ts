// Phase 5 (P4) — Founder mode toggle.
//
// Setting: atrune.founderMode (default false). When true:
//   - Status bar narrator uses plain-English verbs
//   - Approval popups translate technical tool names
//   - TreeView labels become friendlier
//
// Same data shown both ways; only the strings change.

import * as vscode from 'vscode';

export function isFounderMode(): boolean {
  return vscode.workspace
    .getConfiguration('atrune')
    .get<boolean>('founderMode', false);
}

const PHASE_TRANSLATIONS: Record<string, string> = {
  planning: 'your team is drafting a plan',
  building: 'your team is writing the code',
  reviewing: 'your team is reviewing their work',
  verifying: 'your team is double-checking it works',
  working: 'your team is working',
};

const TOOL_TRANSLATIONS: Record<string, string> = {
  Bash: 'run a command',
  Write: 'create a file',
  Edit: 'change a file',
  WebFetch: 'fetch a web page',
  Read: 'read a file',
};

/**
 * Translate a narrator sentence. Devs see "building · Add validation…";
 * founders see "your team is writing the code · Add validation…".
 */
export function translateNarrator(devSentence: string): string {
  if (!isFounderMode()) return devSentence;
  // Sentences come in two shapes:
  //   "<phase> · <brief>"
  //   "<n> approval(s) need you" / "idle …" / "ready" etc.
  const sep = ' · ';
  const idx = devSentence.indexOf(sep);
  if (idx > 0) {
    const phase = devSentence.slice(0, idx);
    const rest = devSentence.slice(idx + sep.length);
    const friendly = PHASE_TRANSLATIONS[phase];
    if (friendly) return `${friendly}${sep}${rest}`;
  }
  return devSentence;
}

/**
 * Translate a tool name for approval popups.
 * "Atrune wants to use Bash" → "Atrune wants to run a command"
 */
export function translateTool(tool: string): string {
  if (!isFounderMode()) return tool;
  return TOOL_TRANSLATIONS[tool] ?? tool.toLowerCase();
}

/** TreeView label rewrites. */
const VIEW_LABELS: Record<string, string> = {
  'Active work': 'What we\'re doing',
  Pending: 'Needs your call',
  Team: 'On the team',
};

export function translateView(devLabel: string): string {
  if (!isFounderMode()) return devLabel;
  return VIEW_LABELS[devLabel] ?? devLabel;
}

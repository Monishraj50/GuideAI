// Phase 5 (P2) — Project templates.
//
// Six curated briefs that pre-fill the composer. The picker runs BEFORE the
// brief composer; users can also pick "Blank brief" to start from scratch.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Template {
  id: string;
  label: string;
  icon: string;
  description: string;
  body: string;
}

interface TemplatesFile {
  templates: Template[];
}

let cached: Template[] | null = null;

function loadTemplates(ctx: vscode.ExtensionContext): Template[] {
  if (cached) return cached;
  try {
    const p = path.join(ctx.extensionPath, 'templates.json');
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as TemplatesFile;
    cached = parsed.templates ?? [];
    return cached;
  } catch (err) {
    console.error('Atrune: failed to load templates.json', err);
    cached = [];
    return cached;
  }
}

/**
 * Show the template picker. Returns a Template (pre-filled body) or null if
 * the user picked Blank (or cancelled).
 *
 * Returns 'blank' explicitly so the caller can distinguish "user wants empty
 * composer" from "user cancelled the whole flow".
 */
export async function pickTemplate(
  ctx: vscode.ExtensionContext,
): Promise<Template | 'blank' | null> {
  const templates = loadTemplates(ctx);

  type Item = vscode.QuickPickItem & { flavor?: 'blank' | 'sep'; tpl?: Template };
  const items: Item[] = [
    {
      label: '$(edit) Blank brief',
      description: 'Write your own from scratch',
      flavor: 'blank',
    },
    {
      label: 'Templates',
      kind: vscode.QuickPickItemKind.Separator,
      flavor: 'sep',
    },
    ...templates.map<Item>((t) => ({
      label: `$(${t.icon}) ${t.label}`,
      description: t.description,
      tpl: t,
    })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Start a brief — pick a template or write your own',
    matchOnDescription: true,
  });
  if (!pick) return null;
  if (pick.flavor === 'blank') return 'blank';
  return pick.tpl ?? null;
}

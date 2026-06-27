// Connect Subscription webview — three provider cards (Claude / Copilot / Codex).
//
// Shown:
//   - On first activation when nothing is connected
//   - Whenever the user runs the `atrune.connectSubscription` command
//   - From the welcome view's "Connect a subscription" link
//
// On success of ANY provider, we set the global context key `atrune.connected`
// to true → the 3 sidebar TreeViews become visible.

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

let panel: vscode.WebviewPanel | undefined;

export type ProviderId = 'claude' | 'copilot' | 'codex';

export interface ConnectionState {
  claude: { connected: boolean; via?: 'cli' | 'apiKey' };
  copilot: { connected: boolean; reason?: string };
  codex: { connected: boolean };
  primary: ProviderId | null;
}

const PRIMARY_SETTING = 'atrune.primaryProvider';

function getPrimary(): ProviderId | null {
  const v = vscode.workspace.getConfiguration().get<string>(PRIMARY_SETTING, '');
  return v === 'claude' || v === 'copilot' || v === 'codex' ? v : null;
}

async function setPrimary(p: ProviderId | null): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    PRIMARY_SETTING, p ?? undefined, vscode.ConfigurationTarget.Global,
  );
}

// Per-folder subscription authorization lives in a marker file INSIDE
// .atrune/ (see folderConsent.ts). The presence of the file IS the signal.
// Deleting .atrune/ wipes both subscription auth AND folder consent in one
// step — exactly the "delete .atrune/ to reset" contract the user wants.
import { hasSubscriptionAuthorized, grantSubscriptionAuthorization, revokeSubscriptionAuthorization } from '../folderConsent';

function currentFolder(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}
function isAuthorizedForFolder(): boolean {
  const folder = currentFolder();
  return !!(folder && hasSubscriptionAuthorized(folder));
}
function authorizeFolder(): void {
  const folder = currentFolder();
  if (folder) grantSubscriptionAuthorization(folder);
}
function deauthorizeFolder(): void {
  const folder = currentFolder();
  if (folder) revokeSubscriptionAuthorization(folder);
}

/** Kept for the extension.ts revoke command — clears the marker explicitly.
 *  In practice revokeAndWipe (rm -rf .atrune/) already takes the file with it. */
export function clearFolderSubscriptionAuthorization(_ctx: vscode.ExtensionContext): void {
  deauthorizeFolder();
}

export async function openConnectSubscription(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  onConnected: () => void,
): Promise<void> {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }

  panel = vscode.window.createWebviewPanel(
    'atrune.connect',
    'AtruneAI · Connect',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');

  async function rerender() {
    // Show real global state ONLY if the user has authorized this folder for
    // subscription use. Until then, force everything to "Not Connected" —
    // the user must click Connect once per folder to opt in.
    const authorized = isAuthorizedForFolder();
    const state = authorized
      ? await detectState(api)
      : forceNotConnectedState();
    panel!.webview.html = renderHtml(state);
    const anyConnected =
      state.claude.connected || state.copilot.connected || state.codex.connected;
    await vscode.commands.executeCommand('setContext', 'atrune.connected', anyConnected);
    if (anyConnected) onConnected();
  }
  await rerender();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {

      case 'connect-claude-key': {
        const key = await vscode.window.showInputBox({
          prompt: 'Paste your Anthropic API key',
          placeHolder: 'sk-ant-…',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => v.trim().startsWith('sk-ant-') ? null : 'Should start with sk-ant-…',
        });
        if (!key?.trim()) return;
        const r = await api.setGlobalClaudeApiKey(key.trim());
        if (r.ok) {
          authorizeFolder();
          vscode.window.showInformationMessage('Atrune · Claude connected.');
          await rerender();
        } else {
          vscode.window.showErrorMessage(`Could not save key: ${r.error}`);
        }
        return;
      }

      case 'connect-claude-cli': {
        const r = await api.connectGlobalClaudeCli();
        if (r.ok) {
          authorizeFolder();
          vscode.window.showInformationMessage('Atrune · Claude CLI connected.');
          await rerender();
        } else {
          vscode.window.showErrorMessage(`Couldn't connect Claude CLI: ${r.error}. Run \`claude login\` in a terminal first.`);
        }
        return;
      }

      case 'connect-copilot': {
        // GitHub Copilot is gated through VS Code's auth provider. We can
        // detect installation but the actual sign-in happens via the GH
        // extension. Surface a friendly path for both states.
        const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
        if (!copilotExt) {
          vscode.window.showInformationMessage(
            'GitHub Copilot extension isn\'t installed. Install it to use Copilot as your provider.',
            'Open Extensions',
          ).then((p) => {
            if (p === 'Open Extensions') {
              vscode.commands.executeCommand('workbench.extensions.search', '@id:GitHub.copilot');
            }
          });
          return;
        }
        try {
          const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
          if (session) {
            authorizeFolder();
            vscode.window.showInformationMessage('Atrune · GitHub Copilot detected.');
            await rerender();
          }
        } catch {
          vscode.window.showWarningMessage('Could not authenticate to GitHub. Try again or use Claude / Codex instead.');
        }
        return;
      }

      case 'connect-codex': {
        const key = await vscode.window.showInputBox({
          prompt: 'Paste your OpenAI API key (powers the Codex provider + cross-vendor review)',
          placeHolder: 'sk-…',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => v.trim().startsWith('sk-') ? null : 'Should start with sk-…',
        });
        if (!key?.trim()) return;
        const r = await api.setGlobalOpenAIApiKey(key.trim());
        if (r.ok) {
          authorizeFolder();
          vscode.window.showInformationMessage('Atrune · OpenAI / Codex connected.');
          await rerender();
        } else {
          vscode.window.showErrorMessage(`Could not save key: ${r.error}`);
        }
        return;
      }

      case 'disconnect-claude': {
        const ok = await vscode.window.showWarningMessage(
          'Disconnect Claude? You can reconnect anytime.',
          { modal: true }, 'Disconnect',
        );
        if (ok !== 'Disconnect') return;
        const r = await api.disconnectGlobalClaude();
        if (r.ok) {
          // If Claude was primary, clear the setting so the UI doesn't dangle.
          if (getPrimary() === 'claude') await setPrimary(null);
          // Disconnect ALSO clears the per-folder subscription marker so the
          // Welcome view flips back to "Step 2 · Connect a subscription".
          // .atrune/.consent.json stays — folder storage is untouched.
          deauthorizeFolder();
          await vscode.commands.executeCommand('setContext', 'atrune.connected', false);
          vscode.window.showInformationMessage('Atrune · Claude disconnected.');
          await rerender();
        } else {
          vscode.window.showErrorMessage(`Could not disconnect: ${r.error}`);
        }
        return;
      }

      case 'disconnect-codex': {
        const ok = await vscode.window.showWarningMessage(
          'Disconnect Codex (OpenAI)? You can reconnect anytime.',
          { modal: true }, 'Disconnect',
        );
        if (ok !== 'Disconnect') return;
        const r = await api.disconnectGlobalOpenAI();
        if (r.ok) {
          if (getPrimary() === 'codex') await setPrimary(null);
          deauthorizeFolder();
          await vscode.commands.executeCommand('setContext', 'atrune.connected', false);
          vscode.window.showInformationMessage('Atrune · Codex disconnected.');
          await rerender();
        } else {
          vscode.window.showErrorMessage(`Could not disconnect: ${r.error}`);
        }
        return;
      }

      case 'disconnect-copilot': {
        // VS Code's auth session is owned by the GitHub provider; we can't
        // revoke it from here. Point the user at the right action.
        vscode.window.showInformationMessage(
          'To sign out of Copilot, use VS Code\'s account menu (avatar, bottom-left) → Sign Out from GitHub.',
        );
        return;
      }

      case 'set-primary': {
        const p = msg.provider as ProviderId | undefined;
        if (!p) return;
        await setPrimary(p);
        vscode.window.setStatusBarMessage(`Atrune · ${p} set as primary`, 3000);
        await rerender();
        return;
      }

      case 'close': {
        panel?.dispose();
        return;
      }
    }
  });

  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
}

/** Render the modal as if no provider is connected — used before the user
 *  has clicked Connect at least once in this folder. We deliberately ignore
 *  the global ~/.guideai/integrations/ tokens here. */
function forceNotConnectedState(): ConnectionState {
  const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
  return {
    claude: { connected: false } as any,
    copilot: {
      connected: false,
      reason: !copilotExt ? 'extension not installed' : 'click Connect to authorize this folder',
    },
    codex: { connected: false },
    primary: getPrimary(),
  };
}

async function detectState(api: AtruneApi): Promise<ConnectionState> {
  const claudeState = await api.getGlobalClaude();
  const openaiState = await api.getGlobalOpenAI();
  const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
  let copilotAuthed = false;
  if (copilotExt) {
    try {
      const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
      copilotAuthed = !!session;
    } catch {}
  }
  return {
    claude: {
      connected: !!claudeState?.ready,
      via: claudeState?.cliConnected ? 'cli' : claudeState?.apiKeySet ? 'apiKey' : undefined,
    } as any,
    copilot: {
      connected: !!copilotExt && copilotAuthed,
      reason: !copilotExt
        ? 'extension not installed'
        : copilotAuthed
          ? undefined
          : 'sign in to GitHub',
    },
    codex: {
      connected: !!openaiState?.apiKeySet,
    },
    primary: getPrimary(),
  };
}

function renderHtml(state: ConnectionState): string {
  function card(opts: {
    id: ProviderId;
    name: string;
    company: string;
    description: string;
    connected: boolean;
    detail?: string;
    primaryAction: { label: string; type: string };
    secondaryAction?: { label: string; type: string };
    disconnectAction?: string;
  }): string {
    const isPrimary = state.primary === opts.id;
    const status = opts.connected
      ? `<span class="status connected">✓ Connected${opts.detail ? ' · ' + opts.detail : ''}</span>`
      : `<span class="status">Not connected${opts.detail ? ' · ' + opts.detail : ''}</span>`;
    return `
      <article class="card ${opts.connected ? 'is-connected' : ''} ${isPrimary ? 'is-primary' : ''}">
        <header>
          <h3>${opts.name} ${isPrimary ? '<span class="star" title="Primary provider">★</span>' : ''}</h3>
          <span class="company">${opts.company}</span>
        </header>
        <p class="desc">${opts.description}</p>
        <div class="actions">
          <button class="primary" data-action="${opts.primaryAction.type}">${opts.primaryAction.label}</button>
          ${opts.secondaryAction ? `<button class="secondary" data-action="${opts.secondaryAction.type}">${opts.secondaryAction.label}</button>` : ''}
        </div>
        ${opts.connected ? `
          <div class="actions secondary-actions">
            ${!isPrimary
              ? `<button class="ghost" data-action="set-primary" data-provider="${opts.id}">Set as primary</button>`
              : `<span class="primary-badge">★ Primary provider</span>`}
            ${opts.disconnectAction ? `<button class="ghost danger" data-action="${opts.disconnectAction}">Disconnect</button>` : ''}
          </div>
        ` : ''}
        ${status}
      </article>`;
  }

  const anyConnected = state.claude.connected || state.copilot.connected || state.codex.connected;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>AtruneAI · Connect</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0e1116);
    --ink: var(--vscode-editor-foreground, #e6e9ef);
    --dim: var(--vscode-descriptionForeground, #7e8390);
    --line: var(--vscode-panel-border, #2a2f3a);
    --soft: var(--vscode-editorWidget-background, #1a1f29);
    --accent: var(--vscode-button-background, #14B8A6);
    --accent-fg: var(--vscode-button-foreground, #0e1116);
    --teal: #14B8A6;
    --teal-fade: rgba(20, 184, 166, 0.08);
    --teal-border: rgba(20, 184, 166, 0.4);
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
  body { padding: 48px 32px 64px; max-width: 1100px; margin: 0 auto; position: relative; }
  .close-x {
    position: absolute; top: 16px; right: 20px;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid var(--line);
    background: transparent; color: var(--dim); cursor: pointer;
    font-size: 16px; line-height: 1;
  }
  .close-x:hover { color: var(--ink); border-color: var(--ink); }
  .hero { text-align: center; margin-bottom: 36px; }
  .hero h1 { font-size: 28px; margin: 0 0 8px; font-weight: 700; letter-spacing: -0.02em; }
  .hero p { color: var(--dim); margin: 0; font-size: 14px; }

  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
  .card {
    background: var(--soft);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px;
    display: flex; flex-direction: column; gap: 12px;
    transition: border-color 0.15s;
  }
  .card.is-connected { border-color: var(--teal-border); background: var(--teal-fade); }
  .card.is-primary { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); }
  .star { color: var(--teal); font-size: 16px; }
  .card header { display: flex; flex-direction: column; gap: 2px; }
  .card h3 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  .card .company { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .desc { color: var(--ink); font-size: 13px; line-height: 1.5; margin: 0; opacity: 0.85; min-height: 60px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }
  button {
    padding: 7px 14px; border-radius: 6px; border: 0;
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  }
  button.primary { background: var(--teal); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.1); }
  button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button.secondary:hover { border-color: var(--teal-border); }
  button.ghost {
    background: transparent; color: var(--dim);
    border: 1px solid var(--line); padding: 5px 10px; font-size: 12px;
  }
  button.ghost:hover { color: var(--ink); border-color: var(--line); }
  button.ghost.danger:hover { color: #f48771; border-color: rgba(244, 135, 113, 0.4); }
  .secondary-actions {
    margin-top: 4px; padding-top: 8px;
    border-top: 1px dashed var(--line);
    align-items: center;
  }
  .primary-badge {
    color: var(--teal); font-size: 12px; font-weight: 500;
    padding: 5px 10px;
  }
  .status { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .status.connected { color: var(--teal); font-weight: 500; }

  .footer { margin-top: 36px; text-align: center; }
  .footer .hint { color: var(--dim); font-size: 12px; margin-bottom: 12px; }
  .footer button { padding: 8px 20px; }

  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <button class="close-x" data-action="close" title="Close (Esc)" aria-label="Close">×</button>

  <div class="hero">
    <h1>Welcome to AtruneAI</h1>
    <p>Connect a coding subscription to power your team. Pick one — or all three. Switch any time.</p>
  </div>

  <div class="grid">
    ${card({
      id: 'claude',
      name: 'Claude',
      company: 'Anthropic',
      description: 'The default runtime. Best results for the full 5-phase pipeline. Connect via the Claude CLI or paste an Anthropic API key.',
      connected: state.claude.connected,
      detail: state.claude.connected ? (state.claude.via === 'cli' ? 'CLI' : 'API key') : undefined,
      primaryAction: { label: state.claude.connected ? 'Replace key' : 'Use API key', type: 'connect-claude-key' },
      secondaryAction: { label: state.claude.connected ? 'Re-bind CLI' : 'Use Claude CLI', type: 'connect-claude-cli' },
      disconnectAction: 'disconnect-claude',
    })}

    ${card({
      id: 'copilot',
      name: 'Copilot',
      company: 'GitHub',
      description: 'Use your GitHub Copilot subscription. Requires the official GitHub Copilot extension installed and signed in.',
      connected: state.copilot.connected,
      detail: state.copilot.reason,
      primaryAction: { label: state.copilot.connected ? 'Reconnect' : 'Connect Copilot', type: 'connect-copilot' },
      disconnectAction: 'disconnect-copilot',
    })}

    ${card({
      id: 'codex',
      name: 'Codex',
      company: 'OpenAI',
      description: 'Powers the Codex provider and cross-vendor sanity checks on security-tagged briefs. Paste an OpenAI API key.',
      connected: state.codex.connected,
      primaryAction: { label: state.codex.connected ? 'Replace key' : 'Use API key', type: 'connect-codex' },
      disconnectAction: 'disconnect-codex',
    })}
  </div>

  <div class="footer">
    <div class="hint">${
      anyConnected
        ? '✓ At least one provider is connected. Your sidebar is active.'
        : 'Connect at least one provider to activate the sidebar.'
    }</div>
    <button class="secondary" data-action="close">${anyConnected ? 'Close' : 'Skip for now'}</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-action');
        const provider = btn.getAttribute('data-provider');
        vscode.postMessage(provider ? { type, provider } : { type });
      });
    });
    // Esc anywhere closes the panel.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') vscode.postMessage({ type: 'close' });
    });
  </script>
</body></html>`;
}

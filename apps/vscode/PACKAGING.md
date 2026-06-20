# Packaging the AtruneAI extension

## Build a fresh .vsix

```bash
pnpm --filter atruneai build
cd apps/vscode
npx --yes @vscode/vsce package --no-dependencies --out atruneai-$(node -p "require('./package.json').version").vsix
```

The `--no-dependencies` flag is required: AtruneAI lives in a pnpm workspace,
and `vsce`'s default dependency walk uses `npm list` which doesn't understand
pnpm's symlinked structure. The extension is fully self-contained in `dist/`
(TypeScript compiled to a flat tree), so we don't need vsce to scan deps.

## Install locally — three editors, one .vsix

The same `.vsix` works on stock VS Code and every fork that implements the VS
Code extension API.

### VS Code

```bash
code --install-extension atruneai-0.1.0.vsix
```

Or: open **Extensions** view → `…` menu → **Install from VSIX…**

### Cursor

```bash
cursor --install-extension atruneai-0.1.0.vsix
```

Or: Extensions view → `…` → Install from VSIX. Cursor uses the same extension
API surface as VS Code 1.85+; everything in this extension is portable.

### Windsurf

```bash
windsurf --install-extension atruneai-0.1.0.vsix
```

Same flow; Windsurf is also VS Code API-compatible. The Atrune brand mark
themes correctly because the activity-bar SVG uses `currentColor`.

## Smoke test checklist

After installing on a target editor:

- [ ] Atrune icon appears in the activity bar (left edge)
- [ ] Clicking it opens the sidebar with three views: Active work · Pending · Team
- [ ] Toolbar buttons render on the Active work title (New brief · Quick ask · Mission Control · Settings)
- [ ] Status bar item appears in the bottom-right: `Atrune · connecting…` initially
- [ ] After a few seconds (auto-spawn), status bar updates with the live narrator
- [ ] **New brief…** opens the template picker, then the brief composer
- [ ] Cost preview popup appears before dispatching
- [ ] `Atrune: Show me around` opens the 5-step walkthrough
- [ ] Right-click any file in Explorer → **Atrune: Auto-fix this…** appears in the menu
- [ ] Select code in the editor → right-click → **Atrune: Ask agent about this selection** appears
- [ ] `atrune.founderMode` toggle changes the status bar narrator wording

## Publishing to the Marketplace

When ready to ship publicly:

```bash
# One-time: create a publisher account at https://marketplace.visualstudio.com/manage
# and store the PAT
npx @vscode/vsce login atrune-ai

# Then:
npx @vscode/vsce publish --no-dependencies
```

The same flow publishes to the Open VSX Registry (used by Cursor + most forks):

```bash
npx ovsx publish atruneai-0.1.0.vsix -p <openvsx-token>
```

## Versioning

Following SemVer:

- `0.1.x` — initial v1
- `0.x` — pre-1.0; breaking changes allowed in minor bumps
- `1.0.0` — first stable release once the extension is feature-complete

Bump with:

```bash
npx @vscode/vsce package --no-dependencies --pre-release  # for 0.x previews
```

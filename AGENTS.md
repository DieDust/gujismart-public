# GujiSmart Maintenance Instructions

These instructions apply to all agent work in this repository.

## Default Workflow

- Treat this project as an open-source Electron application.
- Before changing files, inspect `git status --short` and the relevant nearby code.
- Preserve unrelated user changes. Do not revert, delete, or overwrite dirty worktree changes unless explicitly requested.
- Prefer existing local patterns over new abstractions.
- Keep edits scoped to the requested behavior.

## API Contract Rules

When changing any renderer-facing capability, update the full contract together:

- `src/shared/types.ts`
- `src/preload/index.ts`
- `src/main/ipc/...`
- renderer callers under `src/renderer/src/...`

Do not add optional renderer probes such as `window.api.foo?.(...)` or `typeof window.api.foo === 'function'` for APIs that should exist in preload. Keep the preload contract explicit.

Avoid explicit `any` in source. Prefer `unknown`, local interfaces, type guards, and shared types.

## Open-Source Hygiene

- Do not hardcode real document IDs, private corpus names, absolute local data paths, API keys, or corpus-specific keywords.
- Manual corpus scripts must require inputs through environment variables.
- Use neutral script names such as `manual-corpus`; avoid legacy private-corpus names.
- Keep temporary notes, scratch tests, local findings, and generated private outputs out of the repo.
- Document new public scripts or required environment variables in `docs/`.

## Validation Gates

For ordinary code changes, run:

```powershell
npm run check
npm run build
npm run smoke
git diff --check
```

For dependency changes, also run:

```powershell
npm audit
npm audit --omit=dev
npm ls electron electron-builder @xmldom/xmldom better-sqlite3
```

For Electron, native module, or packaging changes, also run:

```powershell
npx electron-builder install-app-deps
npm run build:unpack
```

Useful contract and hygiene scans:

```powershell
rg -n "Record<string, any>|: any\b|as any\b|Promise<any>|any\[\]" src/preload/index.ts src/main/ipc src/main src/renderer/src --glob "*.ts" --glob "*.tsx"
rg -n "window\.api\.[A-Za-z0-9_]+\?|typeof window\.api\.[A-Za-z0-9_]+ === 'function'|typeof window\.api\.[A-Za-z0-9_]+ !== 'function'" src/renderer/src --glob "*.ts" --glob "*.tsx"
npm run check:opensource
```

No output from the `rg` scans is the expected clean result.

## Reporting

Report in Chinese by default. Include what changed, why it differs from the previous state, which validation commands were run, and any remaining risks or non-blocking warnings.

# Architecture and Interface Conventions

GujiSmart is a local-first Electron application. The codebase is organized around a strict main/preload/renderer boundary so user files, local databases, and external API keys stay in the trusted side of the app.

## Runtime Boundaries

- `src/main/` owns Electron main process work: SQLite access, filesystem access, OCR/AI calls, export, backups, and IPC handlers.
- `src/preload/` exposes the safe renderer API as `window.api`. Renderer code should not import Electron or Node APIs directly.
- `src/renderer/` owns React views, UI state, interaction flow, and display formatting.
- `src/shared/` owns types and constants that cross process boundaries.

## IPC Contract

- IPC channel names should use the existing `domain:action` style, such as `documents:listPage`, `search:queryV2`, and `settings:getAll`.
- Add new APIs through `src/preload/index.ts`; do not call `ipcRenderer.invoke` directly from renderer files.
- Prefer typed request/response payloads exported from `src/shared/types.ts` when data crosses main/preload/renderer.
- Keep raw database row shapes inside `src/main/` unless a renderer view truly needs the row shape for compatibility.

## Naming Rules

- TypeScript functions, component props, and renderer-facing DTOs use `camelCase`.
- SQLite table columns and SQL row objects may use `snake_case`.
- Convert between `snake_case` and `camelCase` at module boundaries. Avoid mixing both styles deep inside React components.
- Settings keys should be treated as a stable interface. Prefer constants or shared helper functions when adding new settings.

## Data and Privacy

- Local user data belongs in Electron user data directories or ignored development folders such as `data/`.
- Do not commit local SQLite databases, private documents, OCR outputs from real libraries, logs, screenshots with private content, or API keys.
- Use `.env.example` for placeholders. Real values belong only in local `.env` files or the app settings UI.
- `npm run check` includes an open-source hygiene scan that blocks common secret and local-path leaks.

## Quality Gates

Run these before opening a pull request:

```bash
npm run check
npm run build
```

Run focused tests for touched areas:

```bash
npm run smoke
npm run test:search
npm run test:evidence-qa
```

For the full script taxonomy and hygiene rules, see [SCRIPTS.md](SCRIPTS.md).

## Refactoring Guidance

- Prefer small compatibility-preserving refactors over broad rewrites.
- When extracting shared interfaces, first add or refine shared types, then update preload, main IPC handlers, and renderer callers together.
- Avoid adding optional `window.api` probes for newly introduced APIs; once an API is part of preload, renderer code should use the typed method directly.
- Large views should gradually move data normalization, filtering, and persistence calls into domain helpers or stores.

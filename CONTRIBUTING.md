# Contributing

Thanks for helping improve GujiSmart. This project is a local-first Electron application for literature management, OCR proofreading, search, and research writing.

## Development

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run check
npm run build
```

Run focused regression scripts when touching related areas:

```bash
npm run test:search
npm run test:evidence-qa
npm run smoke
npm run check:mcp
```

When changing MCP / AI-tool connection surfaces, also update `docs/MCP.md` and keep tools read-only by default.

Manual corpus QA scripts require private local data and are intentionally kept outside the public repository. Do not add scripts, default paths, document IDs, or fallback keywords that depend on a maintainer's private library.

## Code Style

- Keep TypeScript strict and avoid new `any` unless the boundary is genuinely dynamic.
- Put shared API and domain types in `src/shared/` when they cross main, preload, and renderer.
- Keep renderer access through `window.api`; do not bypass preload from React code.
- Prefer small domain modules over growing large view files.
- Do not commit user data, real documents, local databases, logs, generated bundles, or temporary debug output.
- Keep `npm run check` green; it includes type, mojibake, and open-source hygiene checks.
- Follow the process boundary and naming rules in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Naming

- TypeScript and UI-facing DTOs should use `camelCase`.
- SQLite columns and SQL row objects may keep `snake_case`.
- Convert names at module boundaries instead of mixing both styles deep in UI code.

## Pull Requests

Please include:

- A short summary of the user-facing change.
- Screenshots or screen recordings for visible UI changes.
- The commands you ran for verification.
- Notes about data migration or compatibility risk, if any.

## Security

Do not include API keys, credentials, private datasets, institution-only content, or real user library databases in issues or PRs.

## Licensing and Attribution

- New source files are contributed under the project's Apache-2.0 license unless explicitly stated otherwise.
- Do not copy third-party source files, binaries, images, models, datasets, or documentation into the repository without also adding their license and attribution to `THIRD_PARTY_NOTICES.md`.
- Bundled runtime binaries belong under `resources/vendor/` and must keep their upstream license files or notices.
- Prefer package-manager dependencies over vendored code when practical, so license metadata remains traceable through `package-lock.json`.

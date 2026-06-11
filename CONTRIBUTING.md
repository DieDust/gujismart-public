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
```

Manual corpus QA scripts require a local corpus and are not part of the default open-source test path:

```bash
GUJISMART_QA_DATA_DIR=/path/to/local/corpus npm run test:manual-corpus
```

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

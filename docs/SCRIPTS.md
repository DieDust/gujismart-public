# Script Guide

This project keeps public checks self-contained. New contributors should be able to run the default gates without private data, API keys, or local database snapshots.

## Default Gates

Run these before opening a pull request:

```bash
npm run check
npm run build
```

- `npm run check` runs TypeScript, mojibake detection, and open-source hygiene checks.
- `npm run build` cleans `out/` first, then verifies the Electron main, preload, and renderer bundles.
- `npm run size:build` reports current `out/`, `dist/`, and largest renderer asset sizes after a build.
- `npm run smoke` runs the packaged app smoke flow and may take longer than the default checks.

## Build Output Hygiene

Build helpers keep generated output from accumulating across releases:

```bash
npm run clean:build
npm run clean:dist
npm run size:build
```

- `clean:build` removes only `out/`; `npm run build` runs it automatically so stale Vite hash bundles cannot accumulate across builds.
- `clean:dist` removes only `dist/`; run it explicitly before packaging when you want to discard historical installers.
- `size:build` is read-only and useful for checking whether renderer chunks or packaged assets have grown unexpectedly.

## Focused Regression Tests

These tests are designed to be self-contained and should not require private corpus data:

```bash
npm run test:search
npm run test:research
npm run test:evidence-qa
npm run test:ai-ui
```

Prefer adding or updating one of these tests when a change touches search, research notes, evidence QA, or AI markdown rendering.

## Script Hygiene

- Do not commit temporary `inspect-*` scripts or one-off database probes.
- Put local scratch scripts under `scripts/.tmp-*`, which is ignored by git.
- Add reusable scripts to `package.json` or document them here.
- Keep manual QA scripts that depend on private local document libraries outside the public repository.
- Keep API keys, bearer tokens, database paths, and private document paths out of scripts and docs.
- `npm run check:opensource` enforces the most important open-source hygiene rules.

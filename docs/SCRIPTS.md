# Script Guide

This project keeps public checks self-contained. New contributors should be able to run the default gates without private data, API keys, or local database snapshots.

## Documentation helpers

- `node scripts/generate-tutorial-docx.js`  
  Rebuilds `docs/文献管理-图文使用教程.docx` from `docs/文献管理-图文使用教程.md` (requires `npm install docx --no-save`). If the primary `.docx` is open/locked, writes `文献管理-图文使用教程-1.1.10.docx` instead.  
  Re-shoot empty-library screenshots into `docs/images/tutorial-*.png` before regenerating when the UI changes.

## Default Gates

Run these before opening a pull request:

```bash
npm run check
npm run build
```

- `npm run mcp -- --data-dir <path>` starts the **headless MCP server** (no UI) for AI tools; see [MCP.md](MCP.md).
- `npm run check:mcp` verifies MCP tool definitions, stdio server contract, and launcher wiring.
- `npm run check` runs TypeScript, mojibake detection, and open-source hygiene checks.
- `npm run check:function-contract` verifies that critical `window.api` members for OCR, import, reading, search, AI, research, citation, settings, and backup remain exposed.
- `npm run check:status-envelope` verifies the shared status/error envelope and its OCR progress integration.
- `npm run check:config-validation` verifies shared configuration validation reports for provider, OCR, typeset, and backup settings.
- `npm run check:ai-response-envelope` verifies shared AI response envelopes for sources, trace hashes, warnings, and AI IPC integration.
- `npm run check:citation-field-resolver` verifies citation field resolution diagnostics while preserving legacy citation output.
- `npm run check:ocr-run-metadata` verifies OCR run metadata summaries and their centralized progress-event integration.
- `npm run check:document-pipeline-diagnostics` verifies import/document pipeline diagnostics and their centralized import-progress integration.
- `npm run check:search-index-health` verifies search index health diagnostics attached to index status responses.
- `npm run check:backup-integrity` verifies backup manifest integrity reports and restored-data integrity diagnostics.
- `npm run check:metadata-tag-guard` verifies metadata tag normalization and manual-tag cleanup protection.
- `npm run check:module-layering` verifies extracted shared logic stays pure and covered by focused checks.
- `npm run check:managed-path-boundary` verifies canonical managed-storage containment and uses a temporary Electron database to cover document delete recovery, PDF cleanup, and startup orphan cleanup.
- `npm run check:path-mutation-boundary` registers the real document IPC handlers against a temporary SQLite database to verify protected path-only and mixed payloads cause no writes, while ordinary metadata, OCR, proof, and PDF-title initialization remain available.
- `npm run check:file-capabilities` verifies main-only, purpose-bound file and directory grants, including expiry, revocation, target identity changes, symlink/junction rejection, bounded capacity, deterministic batch leases, renderer lifecycle cleanup, and managed-storage-only automatic local-resource access.
- `npm run check:import-capabilities` verifies opaque import references, bounded streaming directory batches, session release and retry, canonical external-folder scans, and actionable queue reauthorization without renderer-supplied paths.
- `npm run check:credential-vault` verifies encrypted sidecar persistence, replacement versions, restart recovery, corruption handling, revocation, and the safeStorage-unavailable boundary.
- `npm run check:credential-drafts` verifies owner/purpose/TTL-bound one-time credential draft references and renderer lifecycle revocation.
- `npm run check:protected-settings` verifies legacy protected-key/profile migration and renderer public-state projection without plaintext secrets.
- `npm run check:settings-security` verifies the cross-layer IPC boundary and runs an Electron/SQLite migration against a temporary legacy database.
- `npm run check:shared-contracts` verifies closed TaskStatus values, TaskStateEnvelope validation, redacted ErrorEnvelope behavior, and typed SettingDefinition validation.
- `npm run check:task-scheduler` runs an Electron/SQLite integration matrix for additive task tables, idempotent jobs/items, bounded claims, lease expiry/reclaim, stale-attempt rejection, pause/cancel/retry, immutable artifact references, event pagination, transaction rollback, and legacy OCR/import queue bridges.
- `npm run check:canonical-content` verifies canonical page priority, bounded hydration, immutable OCR artifacts, active-version reactivation, additive schema re-entry, and reader/search/AI/translation/export provider wiring.
- `npm run check:ocr-proof-preservation` verifies OCR reruns, result saves, and version switches preserve completed human proof while marking its OCR base stale.
- `npm run check:stable-reader-locator` verifies v2 exact/block/page/document validation, honest legacy downgrade, exact-only compatibility projection, quote-context relocation, and search/workspace/research wiring.
- `npm run check:search-snapshot-evidence` verifies additive search generation invalidation, bounded TTL snapshots, criteria/generation validation, canonical exact relocation, source-missing failure, and schema re-entry.
- `npm run check:research-lineage` verifies unique canonical evidence identities, project relations, record CAS/review versions, evidence revalidation, immutable parent-linked outputs, main-built input manifests, and schema re-entry.
- `npm run check:research-aggregate` verifies main-recorded snapshot statistics, immutable aggregate promotion, identity reuse, project relation cursors, stale/corrupt validation, and restart persistence.
- `npm run check:research-claim-manifest` verifies deterministic claim ranges, repeated-text occurrences, UTF-16/non-BMP handling, newline normalization, provenance allowlists, and formal coverage rejection.
- `npm run check:translation-revision-cas` verifies immutable translation context/revisions, late-result CAS conflicts, and manual translation protection.
- `npm run check:citation-snapshot` verifies type-aware citation diagnostics and immutable snapshot stale/corrupt/restart behavior.
- `npm run check:export-snapshot` verifies same-directory atomic export publication, old-target preservation, concurrent staging uniqueness, snapshot identity, and artifact hashes.
- `npm run check:interaction-kernel` verifies close participant aggregation, latest-request-wins tokens, and drag preview/commit/cancel semantics.
- `npm run check:release-evidence` verifies synthetic dual-audience fixtures, SPDX generation, vendor hashes, and the non-public local RC manifest.
- `npm run prepare:release-metadata` writes SBOM, vendor manifest, and local RC evidence under ignored `tmp/package-metadata` for packaging.
- `npm run smoke:packaged` launches `dist/win-unpacked` with isolated user data and verifies package metadata plus a nonblank renderer.
- `npm run check:search-excerpt-source-hash` verifies that manual and batch search excerpt saves keep a compatible source-hash contract.
- `npm run check:research-integrity` verifies the internal research project integrity report used by output snapshots.
- `npm run test:research` verifies research notes, exports, and output input snapshots.
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
npm run check:import-auto-ocr-task
```

Prefer adding or updating one of these tests when a change touches search, research notes, evidence QA, or AI markdown rendering.

`check:import-auto-ocr-task` uses a temporary synthetic SQLite library to verify bounded append, idempotency, import order, restart recovery, and the renderer/main OCR handoff without private documents.

## Script Hygiene

- Do not commit temporary `inspect-*` scripts or one-off database probes.
- Put local scratch scripts under `scripts/.tmp-*`, which is ignored by git.
- Add reusable scripts to `package.json` or document them here.
- Keep manual QA scripts that depend on private local document libraries outside the public repository.
- Keep API keys, bearer tokens, database paths, and private document paths out of scripts and docs.
- `npm run check:opensource` enforces the most important open-source hygiene rules.

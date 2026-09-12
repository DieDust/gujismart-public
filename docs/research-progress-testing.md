# Research Progress Verification

Run `npm run build` before `node scripts/research-progress-ui-regression.js`.
Do not run UI tests concurrently with build commands (the full `npm run check`
also rebuilds output).

The UI regression uses a temporary Electron profile and synthetic IPC handlers.
It never reads user documents or calls a chat model. It checks:

- Visible status before a task ID exists, including indeterminate model waits.
- Actual per-step progress and a status area outside the scrolling results.
- Planning, extraction, and report failures that remain visible after toasts expire.
- Report-only retry without repeating extraction or reporting false success.

Report outcomes are saved to the existing research task steps under `report`.
Extraction completion is independent of report completion. These changes do not
implement full-book extraction, automatic resumption, or a total-duration estimate.

The graph's Analysis History drawer reads saved tasks and steps, including report
errors, independently of the AI panel. Older tasks without a report step explicitly
show that the report outcome is unknown.

After building, run `node scripts/research-graph-ui-regression.js --large` to check
80 synthetic entities, 60 edges, and long evidence at 3840x2032, 2194x1161 with
175% display density, 1440x1000, and 1024x900. The test checks node/label bounds,
canvas and toolbar sizing, independent evidence scrolling, and reopening persisted
report errors. Run without `--large` for zoom, dragging, filtering, and table tests.

# OCR and Reading PDF Feedback Audit

Baseline: published 1.2.34. The fixes below are included in 1.2.35.

## Confirmed Issues

- Reading, plain and searchable PDF exports shared the editable-layout Type 3 font rejection. A synthetically generated valid Type 3 PDF reproduces the reported exception. Only editable layout export now enforces that restriction; ordinary PDF header validation remains. This is not a guarantee that every reading PDF is editable in WPS.
- Settings and onboarding replaced a saved `PaddleOCR-VL` with `PaddleOCR-VL-1.6` on display. Saving that form could overwrite the user's selection. Both views now preserve explicit selections; the default remains 1.6 for unset settings. The runtime normalizer already preserved supported explicit model IDs.
- HTML export attached a new `did-finish-load` listener after awaiting `loadFile`, unnecessarily waiting for its 12-second timeout. It now waits for fonts/images after the completed load instead.
- The async progress-stall timer treated acknowledged `pending`, `queued` and `waiting` states like lost processing jobs after ten minutes. It now keeps polling the existing queued job. Stalled processing, failed status queries and cancellation retain their safeguards. A fake-clock regression reproduces the old queue failure and verifies the fix without paid requests.
- A running PDF job with a slow final group of pages could hit the three-minute progress-stall threshold and submit the same batch again. Result retries now reuse the accepted job and preserve progress; exhausting those retries stops without automatic whole-file/chunk resubmission. This is in-process job reuse, not persisted job recovery after restarting the app. Completed jobs with incomplete page payloads and token failure retain their existing separate handling.
- Historical vertical PDF/VL requests previously forced inner-only overlapping-box filtering (`small`). Keeping enclosing regions (`large`) recovers missing columns in a controlled live page comparison. This change is restricted to the historical vertical profile and VL models, with general/unspecified profiles and PP-Structure unchanged. It does not fix every double-line annotation ordering or transcription error.
- The repeated-generation guard only scanned cycles up to 18 characters and missed long looping lists. Long inputs now also scan cycles up to 256 characters, requiring at least 20 contiguous cycles, 3,600 repeated characters and 65% coverage for these longer cycles. This is a conservative rejection signal for new OCR output, not an automatic text-deletion operation.
- Legacy batch PDF postprocessing now applies the same repeated-generation guard before declaring a page completed. Failed legacy retries update the error status without replacing existing inline or externalized OCR payloads. Regular IPC quality failures likewise preserve previous text and its OCR version while marking the page as an error; retaining text does not certify its accuracy.

## Coordinate Verification

Existing service-to-local-image alignment remains unchanged. Offline checks of five saved live response sets verified image-size alignment, unchanged text and idempotent coordinate processing. One set uses a smaller local render than the service image; the largest rounding difference was 0.5 pixels. Visual overlays did not show an overall coordinate offset in the inspected pages. These are block rectangles, not verified character-level positions, and this does not certify every rotation, crop or historical saved document.

The updated full book has not been rerun through paid OCR and manually transcribed page by page. Recovery on two known missing-column pages and detection of repeated generation are useful regressions, not evidence that all omissions or model errors are eliminated.

## OCR Route and Quality Limits

Single-page Paddle rerecognition uploads an image to the synchronous layout-parsing endpoint. PDF import normally uses the asynchronous PDF job endpoint, with selected model, page-range scheduling and document-specific processing. Both can be Paddle services. The PDF model setting does not select the model behind the synchronous hosted endpoint.

The current code has repeated-generation detection, block-level deduplication and human-proof preservation, with passing synthetic regressions. This does not establish that an old user's repeated TXT or accuracy difference is resolved. Reproduction requires the original page, corresponding TXT, selected settings and preferably the raw OCR response. The initial synthetic audit did not make paid requests. A subsequent, separately authorized live comparison uses a read-only library and stores private artifacts outside the repository. Do not automatically delete repetitions in existing historical texts without checking their source.

A single-page PDF import also uses the async PDF endpoint; it is not equivalent to page-image rerecognition. The reader rerenders the original PDF page before rerecognition. Comparisons must control page identity, PDF text layers, image resolution, model and request options. Successful requests and detected absence of runaway repetition alone do not establish transcription accuracy. Small-file results do not certify long-book or historical vertical-text quality.

Official model choices: [PaddleOCR API documentation](https://www.paddleocr.ai/main/en/version3.x/inference_deployment/serving/paddleocr_official_api/python.html#choose-models). The documented model IDs distinguish VL, VL-1.5, VL-1.6 and PP-StructureV3.

Box-filter semantics: [PaddleOCR layout detection documentation](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/module_usage/layout_detection.html). `small` retains inner boxes and removes enclosing boxes; `large` retains enclosing boxes. This explains the parameter distinction, but actual quality must be checked against page images.

## Regression Commands

```powershell
node scripts/ocr-export-feedback-regression.js
node scripts/ocr-pdf-resume-regression.js
npm run build
npm run check:ocr-export-feedback-ui
npm run check:ocr-layout
npm run check:ocr-proof-preservation
npm run check:batch-processor-save
npm run check:ocr-coordinate
node scripts/ocr-coordinate-tightening-regression.js
npm run check
npm run smoke
```

The first test builds a synthetic Type 3 PDF and exercises production functions obtained through TypeScript AST parsing. Before these fixes are committed, `--baseline` compares the committed version and reproduces the failures. It is diagnostic, not a CI command.

The UI test launches the actual compiled Electron app with an isolated library, saves model choices, reloads the renderer, imports synthetic Chinese text and exports a reading PDF through real preload/IPC. It extracts the PDF text to verify the Chinese body and final marker survive. Only the save-file dialog is redirected to a temporary test destination. The test does not invoke OCR or model services and leaves its fixtures in the printed temporary directory for inspection.

The batch-save test uses isolated SQLite and externalized synthetic payloads. It exercises legacy postprocessing and saves directly, and evaluates the regular IPC save function with isolated dependencies. Failed retries must retain prior OCR, proofreading and payload files; quality failures must remain errors rather than becoming completed pages. This is a storage regression, not a live-provider or end-to-end IPC test.

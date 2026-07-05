# Local OCR Models

GujiSmart keeps local OCR models out of the main installer. When users choose local OCR, the app downloads PP-OCRv6 inference models directly from official Paddle model sources into the user data directory.

## Default Local Model

- Engine: PaddleOCR PP-OCRv6
- Default size: `small`
- Install location: user data directory, under `ocr-addons/pp-ocrv6-<size>`
- Runner: a small GujiSmart adapter script generated locally by the app

The app must not re-upload or mirror official Paddle model files as GujiSmart release assets. Setup and Portable builds should not bundle PP-OCRv6 model files.

## Official Download Source

Automatic download uses Paddle's official model source:

`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0`

For each selected size, GujiSmart downloads both files:

- `PP-OCRv6_<size>_det_infer.tar`
- `PP-OCRv6_<size>_rec_infer.tar`

Supported sizes in the UI:

- `tiny`
- `small`
- `medium`

Catalog pages can be linked from the UI for reference only:

- PaddleOCR official site
- ModelScope PP-OCRv6 collection
- HuggingFace PP-OCRv6 collection

## Install Behavior

- Download supports resume by keeping `.part` files.
- File size is checked against the known official model size.
- Official `.tar` files are extracted into `models/`.
- The generated runner script is written into `runner/run_paddleocr.py`.
- Local OCR status becomes `installed` only when the runner script and both extracted model directories are present.
- Recognition requires an official PaddleOCR/PaddleX runtime version that supports PP-OCRv6. Older runtimes can download the models but will fail to load them.

## Release Checklist

- Do not upload PP-OCRv6 model files to GujiSmart GitHub Releases.
- Verify the main Setup and Portable artifacts do not contain PP-OCRv6 model files.
- Verify automatic download reaches the official Paddle model URLs.
- Verify downloaded files are installed under user data, not the app install directory.

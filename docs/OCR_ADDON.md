# OCR Addon

GujiSmart keeps local OCR out of the main installer. Users can choose local OCR in the OCR settings page, then download or import the optional addon into the app data directory.

## Default Local Model

- Engine: PaddleOCR PP-OCRv6 small
- Addon asset name: `GujiSmart-OCR-PP-OCRv6-small-win-x64.zip`
- Install location: user data directory, under `ocr-addons/pp-ocrv6-small`

The addon should include a runner plus the PP-OCRv6 small detection and recognition models. Main app releases should not bundle this addon in `resources/vendor`.

## Download Sources

The app tries sources in this order when users choose automatic download:

1. GujiSmart GitHub Release asset:
   `https://github.com/DieDust/gujismart-public/releases/latest/download/GujiSmart-OCR-PP-OCRv6-small-win-x64.zip`
2. Paddle official BOS model files:
   `PP-OCRv6_small_det_infer.tar`
   `PP-OCRv6_small_rec_infer.tar`
3. Manual import from a local addon zip.

Model catalog fallback pages are exposed in the UI for checking availability:

- ModelScope PP-OCRv6 collection
- HuggingFace PP-OCRv6 collection

## Release Checklist

- Build and upload `GujiSmart-OCR-PP-OCRv6-small-win-x64.zip` as an extra Release asset.
- Publish the SHA256 and file size with the release notes.
- Verify the main Setup and Portable artifacts do not contain the OCR addon.
- Verify local OCR status becomes `installed` only when both runner and models are present.

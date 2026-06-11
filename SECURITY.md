# Security Policy

GujiSmart stores local documents, OCR text, AI settings, and research notes on the user's machine. Treat all user libraries and API keys as private.

## Supported Versions

Security fixes target the current `main` branch until the project publishes formal release branches.

## Reporting a Vulnerability

Please do not open a public issue for sensitive vulnerabilities. Report privately to the maintainer through GitHub profile contact options, or open a minimal issue that says a private security report is needed without including exploit details.

Include:

- Affected version or commit.
- Reproduction steps.
- Impact and affected data.
- Whether the issue exposes local files, API keys, OCR text, or research notes.

## Handling Secrets

- Never commit API keys, tokens, institution credentials, private documents, local SQLite databases, or generated OCR outputs from real libraries.
- Keep `.env` files local. Use `.env.example` for placeholders only.
- Redact paths and document titles when logs may reveal private collections.

## Electron Boundary

Renderer code should use the preload `window.api` surface. New IPC handlers should validate input, avoid arbitrary filesystem access, and return typed DTOs instead of raw internal objects when possible.

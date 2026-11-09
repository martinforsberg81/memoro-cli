section: Changed

- **A memoro merge regenerates the scan card's locale mirror.**
  `scripts/scan-ocr-languages-mirror.mjs` joins memoro's `derived` commands:
  a change to `src/i18n/locales.js` no longer fails the merge because
  `public/js/msr/cards/document-scan/generated/locales.js` was not regenerated.

section: Changed

- **A round now runs the command gates the repository's selection named.**
  `selectFiles` read `files` from the selector's JSON and dropped the
  `commands` beside them, so no gate round had run one since `select` was
  declared: on a memoro css-only pull request that is `css:lint` and
  `css:tokens`, and on one touching `public/js/` it is `i18n:contract`,
  `i18n:locale-contract` and `i18n:validate`. They run on the **candidate
  only** — several take `--base-ref` and are differential in themselves, so a
  baseline run would measure main against main — every one runs even after
  another fails, each is reported with its own timing, and one that fails makes
  the round red. Measured on memoro #11185 and #11186 (2026-08-31): `css:lint`
  15.1 s, `css:tokens` 1.6 s green; `i18n:contract` red in 4.0 s naming the
  file and the string, with the two gates after it still run and still
  reported.

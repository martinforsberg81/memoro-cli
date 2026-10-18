section: Fixed

- **`mc gate <files…>` runs named files with the declared `pr_tests_flags`.** It read flags only off the `test` script, and memoro's is `node scripts/testing/ci.mjs`, so a memoro test importing `/js/…` failed with ERR_MODULE_NOT_FOUND where memoro's runner adds `--import ./tests/_helpers/browser-paths.mjs`. The flags come from the same declaration the incremental gate already read.

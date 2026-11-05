section: Fixed

- **Current disk status no longer repeats old runner refusals or cleanup
  results after recovery.** The page and `mc tidy` now use one fresh disk
  summary for human output, while named refusal and cleanup diagnostics remain
  available in structured data.

section: Fixed

- **Keep the mc page live after starting a deploy.** The menu returns after
  preflight and confirmation have started the detached deployer, with status
  visible in MERGE & DEPLOY. Merge and deploy frames show the pid on their
  identity row and give status the full next row. Shell `mc deploy` still
  follows its log; explicit `deploy --follow` in the menu does too.

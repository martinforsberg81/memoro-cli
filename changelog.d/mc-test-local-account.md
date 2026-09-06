section: Fixed

- **`mc test dev` no longer hands the production test-account link to a local
  server.** The token is a login to production; a loopback server has its own
  door (memoro's `/dev/login?account=seeded`), and the first full round on the
  two tiers began with the write smoke red on a 404 about a token that had no
  business there. Against loopback mc sets no link, says so in one line, and
  the suite finds its own way in. Production is unchanged.

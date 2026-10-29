section: Changed

- **MC billing now uses each provider's plan through 100%, then its API reserve.** Claude and Codex sessions use a local gateway backed by fixed MC Vault records, so provider API keys stay out of coding-tool environments, arguments and logs. The MC page and `mc run --billing` show both providers' current route; manual billing modes are retired.

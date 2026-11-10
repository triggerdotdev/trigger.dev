---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Use GitHub Actions trusted publishing with `preview archive` and `promote`, without storing API keys. Preview deploys for closed or merged pull requests now archive their branch. `preview archive` also supports Preview environment API keys through `TRIGGER_ACCESS_TOKEN`.

Failed Preview archive operations now exit with an error for API-key and personal-token authentication too, including automatic cleanup during deploys. CI cleanup jobs that previously passed despite an archive failure will now fail. Concurrent cleanup jobs succeed when another job has already archived the same branch generation.

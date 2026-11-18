---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Public-token helpers and chat token creation now prefer server minting for root API keys too, avoiding the legacy claims endpoint on compatible servers. Trigger, batch, and waitpoint responses missing a token also try server minting first.

Root-key callers retain local-signing compatibility only when the mint endpoint is missing or an older server specifically rejects an empty scope list. Named API keys and run tokens never self-sign. Authorization failures, expiration validation errors, rate limits, and server or connection failures do not activate the fallback.

Server minting with a root key signs with that same authenticated key, including during its rotation grace period, rather than with its replacement. Tokens stop authenticating when that key's grace period ends or it is immediately revoked. Deploy this server update before upgrading the SDK if you rely on minting during root-key rotation; older servers can still reject grace-window keys.

Server-minted tokens use the API rate-limit budget and follow the server's expiration rules, including its 30-day maximum. Minting tokens without scopes requires self-hosted v4.8.4 or later unless the root-key compatibility fallback is available. The default expiration remains 15 minutes.

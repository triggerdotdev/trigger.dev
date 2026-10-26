---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Upgrade `socket.io-client` to 4.8.4 so projects using the SDK and CLI install `ws` 8.21 instead of 8.17.1, which has published advisories (GHSA-96hv-2xvq-fx4p, GHSA-58qx-3vcg-4xpx). The old pin blocked upgrading `ws` without a package manager override.

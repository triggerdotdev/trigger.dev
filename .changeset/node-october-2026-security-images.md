---
"trigger.dev": patch
---

Deployed tasks on the `node-22`, `node-24` and `node-26` runtimes (and the default `node` runtime) now run on Node.js 22.23.4, 24.22.1 and 26.12.1, the October 2026 security releases. They fix CVE-2026-111497 (an out-of-bounds write in the Brotli decoder) and several TLS hostname verification bypasses. Redeploy with this CLI version to pick up the patched runtime.

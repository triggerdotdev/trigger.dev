---
"trigger.dev": patch
---

Fix `extraCACerts` in `trigger.config.ts` having no effect on deployed tasks. The CA file is now included in the deployed image and `NODE_EXTRA_CA_CERTS` points at it, so self-signed or corporate certificates are trusted at runtime.

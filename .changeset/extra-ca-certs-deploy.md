---
"trigger.dev": patch
---

Fix `extraCACerts` in `trigger.config.ts` having no effect on deployed tasks. The configured CA file is now copied into the deployment image via the `additionalFiles` build extension, and the deploy command passes its image path to the `NODE_EXTRA_CA_CERTS` build argument, so self-signed or corporate certificates are trusted at runtime.

---
"trigger.dev": patch
"@trigger.dev/core": patch
---

- Resolve issue where CLI could get stuck during deploy finalization
- Unify local and remote build logic, with multi-platform build support
- Improve switch command; now accepts profile name as an argument
- Registry configuration is now fully managed by the webapp
- The deploy `--self-hosted` flag is no longer required
- Enhance deployment error reporting and image digest retrieval

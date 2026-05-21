---
"trigger.dev": patch
---

Pass `TRIGGER_API_URL` and `TRIGGER_SECRET_KEY` to the `bundleSkills` indexer pass in dev so it matches the env the main worker indexer gets. Without this, task files that read CLI-injected env vars at module top level threw on import in the skill-discovery pass while succeeding in the real worker, surfacing as a spurious `[bundleSkills] skill discovery failed, skipping skill bundling: Failed to import some task files` warning on every dev rebuild for any project that doesn't duplicate `TRIGGER_API_URL` into its `.env`.

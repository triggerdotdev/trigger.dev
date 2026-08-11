---
"trigger.dev": patch
---

The dev environment onboarding now tracks real progress. After you run `init`, the setup checklist marks your project as initialized, and it updates live as your dev server connects and your tasks register. The blank state also adds a "Copy AI agent prompt" button that copies a ready-to-paste setup prompt (pre-filled with your project reference) for Claude Code, Cursor, or any coding agent.

The `init` scaffold now imports from `@trigger.dev/sdk` instead of the deprecated `@trigger.dev/sdk/v3` subpath.

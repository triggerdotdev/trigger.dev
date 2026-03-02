---
paths:
  - "packages/**"
---

# Public Package Rules

- Changes to `packages/` are **customer-facing**. Always add a changeset: `pnpm run changeset:add`
- Default to **patch**. Get maintainer approval for minor. Never select major without explicit approval.
- `@trigger.dev/core`: **Never import the root**. Always use subpath imports (e.g., `@trigger.dev/core/v3`).
- When SDK features change, update both `rules/` directory (customer SDK docs) and `.claude/skills/trigger-dev-tasks/` skill files.
- Test changes using `references/hello-world` reference project.

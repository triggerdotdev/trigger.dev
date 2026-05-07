---
paths:
  - "packages/**"
---

# Public Package Rules

- Changes to `packages/` are **customer-facing**. Always add a changeset: `pnpm run changeset:add`
- Default to **patch**. Get maintainer approval for minor. Never select major without explicit approval.
- `@trigger.dev/core`: **Never import the root**. Always use subpath imports (e.g., `@trigger.dev/core/v3`).
- Do NOT update `rules/` or `.claude/skills/trigger-dev-tasks/` unless explicitly asked. These are maintained in separate dedicated passes.
- Test changes using `references/hello-world` reference project.

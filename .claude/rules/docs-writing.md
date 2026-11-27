---
paths:
  - "docs/**"
---

# Documentation Writing Rules

- MDX rendered by the docs site in `apps/docs`; `docs/AGENTS.md` has the full guide, including what each CI check failure means. Frontmatter: `title`, `description`, `sidebarTitle` (optional).
- After creating a new page, add it to `docs.json` navigation under the correct group.
- Components: `<Note>`, `<Warning>`, `<Info>`, `<Tip>`, `<CodeGroup>`, `<Expandable>`, `<Steps>`/`<Step>` (Mintlify's names and props). Pictures of the dashboard are `<DashboardFigure>`, not screenshots (`.claude/skills/docs-dashboard-figures/SKILL.md`).
- Moving or deleting a page: add a `redirects` entry in `docs.json`.
- Check with `pnpm --filter docs-site check --links` (fast), or build and run `check` for everything CI runs.
- Code examples should be complete and runnable where possible.
- Always import from `@trigger.dev/sdk`, never `@trigger.dev/sdk/v3`.
- Keep paragraphs short. Use headers to break up content.
- Link to related pages using relative paths (e.g., `[Tasks](/tasks/overview)`).
- Merging a PR that only changes `docs/` publishes it within minutes. Merge it once what it describes is live. Docs in a PR that also changes code go live with the next `docs-release-*` tag.
- Features behind a flag that isn't fully on:
  - Dark (nobody outside the team has it): don't write docs yet.
  - Private beta or rolling out: put the docs in the feature PR with `<PrivateBeta flag="<key>" />` or `<RollingOut flag="<key>" />` (import from `/snippets/feature-status.jsx`), at the top of the page or the section. Use `flag="env:<NAME>"` for env-var gates. Keep the opening tag on one line with string values. To add page-specific text (how to get access, say), put it inside the tag: `<PrivateBeta flag="<key>">...</PrivateBeta>`; it renders after the fixed line.
  - The PR that removes the flag also removes the callout. CI fails while a callout points at a missing flag.
  - Avoid two callouts in a row. A `<PrivateBeta>` or `<RollingOut>` callout next to another callout is the one exception, because it's temporary. Leave the existing callout as it is.
  - Only for flags that cloud rolls out. Never add it to self-host config docs.

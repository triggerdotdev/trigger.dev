---
paths:
  - "docs/**"
---

# Documentation Writing Rules

- Use Mintlify MDX format. Frontmatter: `title`, `description`, `sidebarTitle` (optional).
- After creating a new page, add it to `docs.json` navigation under the correct group.
- Use Mintlify components: `<Note>`, `<Warning>`, `<Info>`, `<Tip>`, `<CodeGroup>`, `<Expandable>`, `<Steps>`/`<Step>`.
- Code examples should be complete and runnable where possible.
- Always import from `@trigger.dev/sdk`, never `@trigger.dev/sdk/v3`.
- Keep paragraphs short. Use headers to break up content.
- Link to related pages using relative paths (e.g., `[Tasks](/tasks/overview)`).
- Features behind a flag that isn't fully on:
  - Dark (nobody outside the team has it): don't write docs yet.
  - Private beta or rolling out: put the docs in the feature PR with `<PrivateBeta flag="<key>" />` or `<RollingOut flag="<key>" />` (import from `/snippets/feature-status.jsx`), at the top of the page or the section. Use `flag="env:<NAME>"` for env-var gates. Keep it on one line with string values.
  - The PR that removes the flag also removes the callout. CI fails while a callout points at a missing flag.
  - Avoid two callouts in a row. A `<PrivateBeta>` or `<RollingOut>` callout next to another callout is the one exception, because it's temporary. Leave the existing callout as it is.
  - Only for flags that cloud rolls out. Never add it to self-host config docs.

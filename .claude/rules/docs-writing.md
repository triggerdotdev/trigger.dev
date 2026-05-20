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

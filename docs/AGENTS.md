# Documentation

MDX documentation for Trigger.dev, rendered by the docs site in `apps/docs`.

## Running and checking locally

From `trigger.dev/`:

- `pnpm --filter docs-site dev`: the site at http://localhost:43000/docs, reloading as you edit.
- `pnpm --filter docs-site check --links`: every internal link and `#anchor` resolves (a second or two, no build).
- `pnpm --filter docs-site build && pnpm --filter docs-site check`: the full check CI runs on docs PRs (links, every published URL and redirect).

Before you open a PR, run what CI runs, from `trigger.dev/`:

```bash
pnpm --filter docs-site build:sdk   # once per checkout, and again after SDK changes
pnpm --filter docs-site build
pnpm --filter docs-site check
pnpm --filter docs-site test
```

`pnpm exec tsc --noEmit` in `apps/docs` prints TS2307 errors (`@/.generated/*`, the SDK) on a fresh checkout. They go away once `build:sdk` and a `dev` or `build` have run, which write those files; they aren't from your change.

## Configuration

- `docs.json`: the navigation (`navigation.dropdowns` -> groups -> pages) and `redirects`. The site reads both; Mintlify-only settings in it (theme, colors) do nothing.
- The site itself: `apps/docs` (see its README). Writers don't need to touch it.

## Writing Docs

Pages are MDX files. Frontmatter format:

```yaml
---
title: "Page Title"
description: "Brief description for SEO and previews"
sidebarTitle: "Short Title"  # Optional, shown in sidebar if different from title
---
```

`hidden: true` keeps a page out of the sidebar but it stays in search engines and the sitemap. Add `noindex: true` to keep a page out of search engines too.

## Adding a New Page

1. Create the MDX file in the appropriate directory.
2. Add the page path to `docs.json` navigation (under the correct group), without the extension.
3. Run `pnpm --filter docs-site check --links`.

## Moving, renaming or deleting a page

Add a redirect to `docs.json` `redirects` from the old path, in the same PR:

```json
{ "source": "/old/path", "destination": "/new/path" }
```

Never remove a published page without one: CI requests every URL in the published sitemap and fails on a 404.

Also repoint internal links to the new path (`check --links` accepts the old one because the redirect exists), and search the dashboard for links into the docs: `grep -rn '"/old/path' apps/webapp/app`.

## Snippets

Shared MDX lives in `snippets/`. Import it with a path from the docs root and use it as a component:

```mdx
import CliDevStep from "/snippets/step-cli-dev.mdx";

<CliDevStep />
```

## Components

The same names and props as the Mintlify components the pages already use (implemented in `apps/docs/components/mintlify.tsx`):

- `<Note>`, `<Warning>`, `<Info>`, `<Tip>`, `<Check>`: callouts
- `<Steps>` / `<Step>`: step-by-step instructions
- `<CodeGroup>`: multi-file or multi-language code examples
- `<Tabs>` / `<Tab>`: different paths (App Router vs Pages Router)
- `<Accordion>` / `<AccordionGroup>`, `<Expandable>`: collapsible content
- `<Card>` / `<CardGroup>`: link grids
- `<ParamField>`, `<ResponseField>`: reference tables
- ` ```mermaid ` fences: diagrams

Docs-site only:

- `<SdkType name="TaskOptions" />` - every property of an SDK type, generated from the SDK's types and JSDoc (types listed in `apps/docs/lib/sdk-types/index.ts`)

## Links

- Link with paths from the docs root: `[Tasks](/tasks/overview)`, never `/docs/...`.
- Heading anchors: lowercase, punctuation dropped, dots and spaces become hyphens, `/` and `—` kept. `## chat.agent()` is `#chat-agent`, a repeated heading gets `-2`. `check --links` reports any that don't match.

## Code Examples

- Always import from `@trigger.dev/sdk` (never `@trigger.dev/sdk/v3`)
- Make code examples complete and runnable where possible
- Use language tags in code fences: `typescript`, `bash`, `json`
- TypeScript blocks that import from `@trigger.dev/*` get type hovers on the built site, from the SDK's types. Nothing to add to the fence; `no-twoslash` in the fence meta skips a block. Type errors are not reported and never fail the build (most samples are excerpts that use names defined elsewhere), so a misspelled method like `tags.ad(...)` passes silently. Check new calls yourself: on the preview, a real SDK call shows a hover and a typo shows none.
- Install and CLI commands: write the npm version once in a `bash` block with no title. The site shows it as npm, pnpm, yarn and bun tabs that follow the reader's package manager. A hand-written `<CodeGroup>` with fences titled `npm`, `pnpm`, `bun` works too.

## API reference pages

API pages come from `openapi.yml` and `v3-openapi.yaml`: a page names its operation in `openapi:` frontmatter and has no body of its own.

## Publishing

- A PR that only changes `docs/` goes live within minutes of merging. Merge it once what it describes is live.
- Docs in a PR that also changes code go live with the next `docs-release-*` tag.
- A docs-only change that conflicts with unpublished docs, or links to an unpublished page, waits for the next tag. The publish run comments on the commit when that happens.
- Every published version is built and checked (every URL, security headers) before it replaces the live site. If a check fails, the live site stays as it was.

## Checks on a docs PR

CI builds the site and runs `pnpm --filter docs-site check`. Run the same locally (see above). What a failure means:

| Output | Cause | Fix |
| --- | --- | --- |
| `BROKEN <file>:<line>: <href> (no such page)` | A link to a page that doesn't exist and isn't a redirect. | Fix the path, or add a redirect if the page moved. |
| `BROKEN ... (no heading #<anchor>)` | The heading was renamed, or the anchor doesn't follow the rule under Links. | Use the anchor the heading produces now. |
| `BROKEN ... (has a /docs prefix ...)` | A link starting with `/docs/`. | Drop the `/docs` prefix. |
| `BROKEN ... (no such file)` | An image or file path that doesn't exist. | Fix the path under `images/`. |
| `FAIL sitemap <path> -> 404` | A published page was moved or deleted without a redirect. | Add a `redirects` entry. |
| `FAIL redirect <path> -> ... (want ...)` | A redirect points at a page that doesn't exist, or loops. | Point it at a live page. |
| `SDK types aren't built` | The build ran without `pnpm --filter docs-site build:sdk`. | Run it once, then build again. |
| A build error naming an MDX file | Invalid MDX: an unclosed tag, a bare `<` or `{` in text. | Escape it (`\<`, `\{`) or put it in backticks. |
| `FAIL` from `check-headers` | The site's code, not the content. | Ask whoever changed `apps/docs`. |

Pull requests from the team also get a preview deployment, linked in a PR comment.

## Directory Structure

- `documentation/` - Core conceptual docs
- `guides/` - How-to guides
- `config/` - Configuration reference
- `deployment/` - Deployment guides
- `tasks/` - Task documentation
- `realtime/` - Real-time features
- `runs/` - Run management
- `images/` - Image assets

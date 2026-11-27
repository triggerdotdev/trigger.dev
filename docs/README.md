# Development

The docs are MDX in this folder, rendered by the docs site in `apps/docs`.

## Install and initial setup

`pnpm install` (from `trigger.dev/`)

## Running the site

`pnpm --filter docs-site dev`, then open http://localhost:43000/docs

What dev does differently from the built site:

- The first page after a fresh start compiles every page, so it takes a while (about 15 s on a 16-core machine). Later starts reuse `apps/docs/.next` and the first page takes about 4 s. Edits show up in about a second.
- No type hovers on code samples (`DOCS_TWOSLASH=1` turns them on, and slows the first page a lot).

## Checking your changes

- `pnpm --filter docs-site check --links`: links and anchors (fast, no build)
- `pnpm --filter docs-site build:sdk` once, then `pnpm --filter docs-site build && pnpm --filter docs-site check`: everything CI checks

What a failure means and how to fix it: `AGENTS.md`, "Checks on a docs PR".

## Mintlify (until the switch)

Until the switch, the live site still deploys from Mintlify, which renders neither `<DashboardFigure>` nor `<SdkType>`. `pnpm run dev --filter docs` runs the Mintlify preview at http://localhost:3050.

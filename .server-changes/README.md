# Server Changes

This directory tracks changes to server-only components (webapp, supervisor, etc.) that are not captured by changesets. Changesets only track published npm packages — server changes would otherwise go undocumented.

## When to add a file

These entries are **user-facing release notes**, not a catalog of every change. The test is "would a user or customer care about this change?", not "did I touch a server app?". Add one only when a server-only change is something a user would notice, act on, or want to hear about (a feature, a bug fix they could have hit, a behavior or performance change they would feel). Skip it for internal-only or admin-only changes, refactors, test-only changes, chores, and performance tuning with no user-visible effect. Anyone who wants the exact history reads the commits. When in doubt, ask a maintainer rather than adding a note by default.

**Server-only PRs**: If your PR only changes `apps/webapp/`, `apps/supervisor/`, or other server components (and does NOT change anything in `packages/`) AND the change is user-facing, add a `.server-changes/` file.

**Mixed PRs** (both packages and server): the changeset covers it, so no `.server-changes/` file is needed. If the package change is internal and needs no changeset but the server change is user-facing, add a `.server-changes/` file for it.

**Package-only PRs**: Just add a changeset as usual, when the change is user-facing.

## File format

Create a markdown file with a descriptive name:

```
.server-changes/fix-batch-queue-stalls.md
```

With this format:

```markdown
---
area: webapp
type: fix
---

Speed up batch queue processing by removing stalls and fixing retry race
```

### Fields

- **area** (required): `webapp` | `supervisor`
- **type** (required): `feature` | `fix` | `improvement` | `breaking`

### Description

The body text (below the frontmatter) is a one-line description of the change. Keep it concise — it will appear in release notes.

### Writing guidance

These entries are public-facing - they ship verbatim in user-visible release notes. A few rules to keep them clean:

- **Write for the user, not the reviewer.** Lead with what the user notices or has to do. If a reader who doesn't know the codebase can't tell what changed for them, rewrite it.
- **One sentence is usually enough.** The body is the bullet in the changelog. If you need a paragraph, you're probably describing the implementation rather than the change.
- **Describe behavior, not implementation.** Skip internal scopes, middleware names, library specifics, framework internals. Users care about what's different for them, not how it's wired.
- **Never name internal tools or infra.** Observability stacks, internal services, infra components, monitoring backends, CI surfaces, AWS specifics - none of these belong in user-facing notes.

Before / after:

- ❌ _"The image verification step now parses the manifest's layer media types and returns a new result the finalizer rejects."_ (describes the wiring; a user can't act on it)
- ✅ _"Deploying with an outdated CLI could produce an image that fails to start on every run. These deploys are now stopped before going live, with a message asking you to upgrade the CLI and re-deploy."_ (what the user sees and does)

## Lifecycle

1. Engineer adds a `.server-changes/` file in their PR
2. Files accumulate on `main` as PRs merge
3. The changeset release PR includes these in its summary
4. After the release merges, CI cleans up the consumed files

## Examples

**New feature:**

```markdown
---
area: webapp
type: feature
---

TRQL query language and the Query page
```

**Bug fix:**

```markdown
---
area: webapp
type: fix
---

Fix schedule limit counting for orgs with custom limits
```

**Improvement:**

```markdown
---
area: webapp
type: improvement
---

Use the replica for API auth queries to reduce primary load
```

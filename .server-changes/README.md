# Server Changes

This directory tracks changes to server-only components (webapp, supervisor, coordinator, etc.) that are not captured by changesets. Changesets only track published npm packages — server changes would otherwise go undocumented.

## When to add a file

**Server-only PRs**: If your PR only changes `apps/webapp/`, `apps/supervisor/`, `apps/coordinator/`, or other server components (and does NOT change anything in `packages/`), add a `.server-changes/` file.

**Mixed PRs** (both packages and server): Just add a changeset as usual. No `.server-changes/` file needed — the changeset covers it.

**Package-only PRs**: Just add a changeset as usual.

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

- **area** (required): `webapp` | `supervisor` | `coordinator` | `kubernetes-provider` | `docker-provider`
- **type** (required): `feature` | `fix` | `improvement` | `breaking`

### Description

The body text (below the frontmatter) is a one-line description of the change. Keep it concise — it will appear in release notes.

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

---
paths:
  - "apps/**"
---

# Server App Changes

`.server-changes/` files are user-facing release notes, not a catalog of every change. When a user-facing server app change (webapp, supervisor, etc.) is in a PR with **no package or integration change that requires a changeset**, add a `.server-changes/` file instead of a changeset. Skip it for internal-only or admin-only changes, refactors, and chores:

```bash
cat > .server-changes/descriptive-name.md << 'EOF'
---
area: webapp
type: fix
---

Fix pages occasionally loading unstyled during deploys. The dashboard now recovers automatically.
EOF
```

- **area**: `webapp` | `supervisor`
- **type**: `feature` | `fix` | `improvement` | `breaking`
- If the PR also touches `packages/` or `integrations/` and that change needs a changeset, the changeset covers it (no `.server-changes/` needed). If the package or integration change is internal and needs no changeset, still add a `.server-changes/` file for the user-facing server change.

The body ships **verbatim in user-facing release notes**. Keep it to 1–2 short sentences, non-technical, written for a dashboard user: describe what changed for them, never the implementation (no header names, endpoints, middleware, storage mechanisms, internal tools). See `.server-changes/README.md` for full guidance.

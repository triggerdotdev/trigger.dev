---
paths:
  - "apps/**"
---

# Server App Changes

When modifying server apps (webapp, supervisor, etc.) with **no package changes**, add a `.server-changes/` file instead of a changeset:

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
- If the PR also touches `packages/`, just the changeset is sufficient (no `.server-changes/` needed).

The body ships **verbatim in user-facing release notes**. Keep it to 1–2 short sentences, non-technical, written for a dashboard user: describe what changed for them, never the implementation (no header names, endpoints, middleware, storage mechanisms, internal tools). See `.server-changes/README.md` for full guidance.

<!-- Documents .claude/rules/server-apps.md module purpose and public usage context -->
---
paths:
  - "apps/**"
---

# Server App Changes

When modifying server apps (webapp, supervisor, coordinator, etc.) with **no package changes**, add a `.server-changes/` file instead of a changeset:

```bash
cat > .server-changes/descriptive-name.md << 'EOF'
---
area: webapp
type: fix
---

Brief description of what changed and why.
EOF
```

- **area**: `webapp` | `supervisor` | `coordinator` | `kubernetes-provider` | `docker-provider`
- **type**: `feature` | `fix` | `improvement` | `breaking`
- If the PR also touches `packages/`, just the changeset is sufficient (no `.server-changes/` needed).

---
paths:
  - "apps/**"
---

# Server App Changes

When modifying server apps (webapp, supervisor, coordinator, etc.), add a `.server-changes/`:

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

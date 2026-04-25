---
area: webapp
type: improvement
---

Add `dashboardLoader` / `dashboardAction` route builders that route session auth through the RBAC plugin (`rbac.authenticateSession` + `ability.canSuper()` / `ability.can`) and migrate the platform admin pages onto them. Routes that only need a logged-in user with no authorisation continue to use `requireUser` / `requireUserId` — the builder is opt-in for routes with explicit auth checks. Migrated routes: `admin.tsx`, `admin._index.tsx`, `admin.concurrency.tsx`, `admin.feature-flags.tsx`, `admin.notifications.tsx`, `admin.orgs.tsx`, `admin.data-stores.tsx`, `admin.back-office.tsx` (+ children), `admin.llm-models.*` (5 routes). Behavioural change: actions that previously threw `403 Unauthorized` on non-admins now redirect to `/` along with the loader — uniform with the builder's behaviour.

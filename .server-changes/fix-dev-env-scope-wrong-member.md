---
area: webapp
type: fix
---

Fix `OrganizationsPresenter.#getEnvironment` matching the wrong development environment on teams with multiple members. All dev environments share the slug `"dev"`, so the previous `find` by slug alone could return another member's environment. Now filters DEVELOPMENT environments by `orgMember.userId` to ensure the logged-in user's dev environment is selected.

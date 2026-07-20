---
area: webapp
type: fix
---

Updating a GitHub App installation from the callback flow is now scoped to your own organization, so an installation ID belonging to another organization can no longer be used to refresh that organization's installation record. The GitHub App installation session is also now single-use, so completing an installation callback invalidates its state and it can no longer be replayed.

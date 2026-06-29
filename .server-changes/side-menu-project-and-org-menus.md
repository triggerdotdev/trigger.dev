---
area: webapp
type: improvement
---

Restructure the side menu's top-left and project/organization navigation:

- Add a new "Project" section above the "Environment" section with a popover
  that lists the org's projects (folder icon + checkmark for the selected one)
  and a "New project" item at the bottom.
- The top-left menu now shows the organization (avatar + org name, no
  project/diagonal divider) and its popover is a clean list of org-level items
  (Settings, Usage, Billing with plan badge, Billing alerts, Team, Private
  connections, Roles, SSO, Vercel integration, Slack integration, Switch
  organization, then Account and Logout) using the same icons and links as the
  organization settings side menu.

The org loader now exposes whether the RBAC and SSO plugins are installed so the
side menu can gate the Roles and SSO items the same way the settings side menu
does.

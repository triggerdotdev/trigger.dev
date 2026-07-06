---
area: webapp
type: improvement
---

Refresh the side menu and account UI:

- Add a new "Project" section above the "Environment" section with a popover
  that lists the org's projects (folder icon + checkmark for the selected one)
  and a "New project" item at the bottom.
- The top-left menu now shows the organization (avatar + org name, no
  project/diagonal divider) and its popover is a clean list of org-level items
  (Settings, Usage, Billing with plan badge, Billing alerts, Team, Private
  connections, Roles, SSO, Vercel integration, Slack integration, Switch
  organization), with a separate account menu button (Profile, Personal Access
  Tokens, Security, admin/impersonation, Logout) beside it.
- Match the Environment selector popover's item sizing (icons and labels,
  including the branch submenu and its footer) to the Project popover so the two
  side-menu menus are visually consistent.
- Redesign the account Profile page (/account) into the Security page's
  row-and-divider layout: Profile picture, Full name, Email address, and a
  "Receive onboarding emails" toggle on equal-height rows, with a primary Update
  button.
- Signal impersonation mode with a yellow side-menu border and a matching
  "Stop impersonating" accent.

The org loader now exposes whether the RBAC and SSO plugins are installed so the
side menu can gate the Roles and SSO items the same way the settings side menu
does.

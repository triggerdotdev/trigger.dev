---
area: webapp
type: feature
---

Enforce role-based permissions across the dashboard and API. New permission boundaries cover: runs (cancel, replay, bulk actions), deployments (rollback, promote, cancel), prompt versions, organization members (invite, resend, revoke), billing and seat purchases, integrations (GitHub and Vercel), and environment variables and API keys (restricted by environment tier). Roles without access can no longer read or change these, gated controls are disabled with a tooltip, and gated pages show a permission-denied panel instead of redirecting away. Behaviour is unchanged in the default configuration, where permissions stay permissive.

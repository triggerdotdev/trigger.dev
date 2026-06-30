---
area: webapp
type: fix
---

Fixed invite acceptance failing for organizations with many projects.

When environment provisioning failed after membership was created, users with a single pending invite were redirected away before seeing the error. They now land on the orgs page with a persistent error toast; users with other pending invites still see a FormError on the invites page.

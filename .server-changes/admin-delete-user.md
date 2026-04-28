---
area: webapp
type: feature
---

Admin can delete a user from `/admin`. Hard-deletes the User row, soft-deletes any organization the user is the sole member of. Action proxies to the billing service which runs the deletion in a single transaction.

---
area: webapp
type: fix
---

Save the user's timezone preference for any zone the browser reports, including UTC and alias zones (e.g. Etc/UTC, Asia/Kolkata) that were previously rejected. Without this, affected users had timestamps stuck in a previously-saved timezone.

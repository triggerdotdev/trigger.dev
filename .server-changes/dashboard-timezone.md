---
area: webapp
type: fix
---

Fix the date/time tooltip's timezone offset label so it always matches the displayed local time, including across daylight saving boundaries, and let users whose browser reports UTC or an alias zone (e.g. Etc/UTC, Asia/Kolkata) save their timezone preference instead of it silently failing.

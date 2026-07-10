---
area: webapp
type: fix
---

The Errors page now shows better details for each error. Errors that don't carry a message — such as errors thrown without a message, or values thrown that aren't `Error` objects — get a meaningful title instead of all reading "Unknown error", and are grouped by their name (or value) rather than collapsed into a single group. The error type now shows the actual error name, and stack traces now appear where previously they were missing.

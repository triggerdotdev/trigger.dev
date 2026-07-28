---
"@trigger.dev/core": patch
---

Redact common credential and sensitive-data fields from structured logger output by default, including nested values and error metadata. Long strings and arrays are now truncated to keep log entries manageable.

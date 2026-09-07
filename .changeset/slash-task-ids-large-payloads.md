---
"@trigger.dev/sdk": patch
---

Fixes storage of large trigger payloads for task ids containing a slash, which could fail the trigger with an "Invalid packet storage path" error. It affected ids that started or ended with a slash, contained two slashes in a row, or contained a `.` or `..` path component. The storage path is now built from a generated id rather than from the task id, so no task id can produce an unusable one, and payloads that are already stored are still read from where they were written.

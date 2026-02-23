---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add `.wait()` method to input streams for suspending tasks while waiting for data. Unlike `.once()` which keeps the task process alive, `.wait()` suspends the task entirely, freeing compute resources. The task resumes when data arrives via `.send()`.

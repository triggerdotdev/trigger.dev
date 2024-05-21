---
"trigger.dev": patch
"@trigger.dev/core": patch
---

- Clear paused states before retry
- Detect and handle unrecoverable worker errors
- Remove checkpoints after successful push
- Permanently switch to DO hosted busybox image
- Fix IPC timeout issue, or at least handle it more gracefully
- Handle checkpoint failures
- Basic chaos monkey for checkpoint testing
- Stack traces are back in the dashboard
- Display final errors on root span

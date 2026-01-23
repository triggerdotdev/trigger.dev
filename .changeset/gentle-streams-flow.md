---
"@trigger.dev/core": patch
---

Fix batch trigger failing with "ReadableStream is locked" error when network failures occur mid-stream. Added safe stream cancellation that gracefully handles locked streams during retry attempts.

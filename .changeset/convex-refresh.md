---
"@trigger.dev/convex": patch
---

Add `trigger.refresh(ctx, id)` to request an earlier status check for a Convex-tracked run, so applications using Trigger Realtime can publish results without waiting for the next scheduled poll. Requests are coalesced and rate-limited, use the existing completion callback, and retain polling as a recovery fallback.

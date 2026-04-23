---
area: webapp
type: fix
---

Fix memory leak where every aborted SSE connection and every successful HTML render pinned the full request/response graph on Node 20, caused by `AbortSignal.any` + string abort reasons in `sse.ts` and an un-cleared `setTimeout(abort)` in `entry.server.tsx`.

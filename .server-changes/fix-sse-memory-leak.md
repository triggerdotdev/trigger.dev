---
area: webapp
type: fix
---

Fix memory leak where every aborted SSE connection pinned the full request/response graph on Node 20, caused by `AbortSignal.any()` in `sse.ts` retaining its source signals indefinitely (see nodejs/node#54614, nodejs/node#55351). Also clear the `setTimeout(abort)` timer in `entry.server.tsx` so successful HTML renders don't pin the React tree for 30s per request.

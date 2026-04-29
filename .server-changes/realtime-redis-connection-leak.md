---
area: webapp
type: fix
---

Fix Redis connection leak in realtime streams and broken abort signal propagation.

**Redis connections**: Non-blocking methods (ingestData, appendPart, getLastChunkIndex) now share a single Redis connection instead of creating one per request. streamResponse still uses dedicated connections (required for XREAD BLOCK) but now tears them down immediately via disconnect() instead of graceful quit(), with a 15s inactivity fallback.

**Abort signal**: request.signal is broken in Remix/Express due to a Node.js undici GC bug (nodejs/node#55428) that severs the signal chain when Remix clones the Request internally. Added getRequestAbortSignal() wired to Express res.on("close") via httpAsyncStorage, which fires reliably on client disconnect. All SSE/streaming routes updated to use it.

---
area: webapp
type: fix
---

Fix OTLP nanosecond-timestamp overflow in the v3 event repository. Four call sites computed `BigInt(date.getTime() * 1_000_000)` — the multiplication runs in float-land before the BigInt conversion, and `epoch_ms * 1e6` is ~1.7e18, well past `Number.MAX_SAFE_INTEGER` (~9e15). The result loses ~256 ns of precision on ~0.2% of calls, which can disorder spans that finish near a millisecond boundary. Convert to BigInt first (`BigInt(ms) * BigInt(1_000_000)`) to match the existing `convertDateToNanoseconds()` pattern in the same file.

Sites fixed:
- `apps/webapp/app/v3/eventRepository/common.server.ts:getNowInNanoseconds`
- `apps/webapp/app/v3/eventRepository/common.server.ts:calculateDurationFromStart`
- `apps/webapp/app/v3/eventRepository/index.server.ts:recordRunDebugLog`
- `apps/webapp/app/v3/runEngineHandlers.server.ts` retry event recording

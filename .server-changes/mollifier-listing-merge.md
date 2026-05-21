---
area: webapp
type: feature
---

Run listing endpoints now include buffered runs transparently (Phase E — Q1 design).

`GET /api/v1/runs` and `GET /api/v1/projects/{projectRef}/runs` route through `callRunListWithBufferMerge`. The helper fetches a watermark-anchored page from the mollifier buffer via `MollifierBuffer.listForEnvWithWatermark`, synthesises each entry into the same shape `ApiRunListPresenter` returns for PG rows (status `QUEUED`, all timestamps derived from the entry hash, env slug looked up once per request), and merges the two sources by `createdAt DESC` with `runId DESC` tiebreak. Truncates to `pageSize` total.

Cursor is a compound base64-JSON `{ inner, watermark, bufferExhausted }`. The `inner` field carries the existing PG/ClickHouse cursor unchanged so the underlying presenter is untouched. Legacy cursors (plain strings from older SDKs) are accepted and treated as `bufferExhausted: true` — those clients see PG-only listing, matching today's behaviour. Once the buffer source returns fewer than `pageSize` entries below the watermark, `bufferExhausted` latches true and subsequent pages skip the buffer entirely (Q1 D4).

Buffer is skipped when filters don't match buffered runs (status filter excluding QUEUED/PENDING/DELAYED, region/machine/version/batch/schedule filters — none of which buffered runs carry). Buffer outages fall open to PG-only for that request.

Removes the `RecentlyQueuedSection` banner from the dashboard runs index — buffered runs now appear in the main list as normal `QUEUED` rows (Q1 D5).

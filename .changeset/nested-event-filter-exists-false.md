---
"@trigger.dev/core": patch
---

Fix `eventFilterMatches` so nested filters that assert the absence of a value match when an ancestor key is missing or `null`, instead of failing before the filter is evaluated. A missing payload is now matched like an empty object: it's how `$exists` behaves on nested paths elsewhere, and how these filters already behaved for a missing key at the top level.

This changes the result only for filters whose leaves match a missing key today, i.e. `$exists: false`, `$isNull: false` and `$anythingBut`. Filters that require a value (`$exists: true`, `$startsWith`, `$gt`, value arrays, ...) are unchanged. It fixes `retry.fetch`'s `bodyFilter` (e.g. `{ error: { retryAfter: [{ $exists: false }] } }`) not matching responses that have no `error` object.

---
"@trigger.dev/react-hooks": patch
---

Added a `useSessionStream` React hook for reading a session's output or input channel in realtime. It accumulates records with automatic resume from the last record you received, and supports `from: "latest"` (start at the current tail, only new records after you connect), `maxRecords` (keep a bounded number of records in memory), a `lastEventId` resume cursor, and an `onRecords` callback that delivers each throttled batch of records with their event ids.

---
"@trigger.dev/sdk": patch
"@trigger.dev/react-hooks": patch
---

- Fixes an issue in streams where "chunks" could get split across multiple reads
- Fixed stopping the run subscription after a run is finished, when using useRealtimeRun or useRealtimeRunWithStreams
- Added an `onComplete` callback to `useRealtimeRun` and `useRealtimeRunWithStreams`
- Optimized the run subscription to reduce unnecessary updates

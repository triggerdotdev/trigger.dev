---
area: webapp
type: improvement
---

Extend `SyntheticRun` (the mollifier read-fallback synthesised TaskRun shape) with the fields `ReplayTaskRunService` reads: `id`, `runtimeEnvironmentId`, `engine`, `workerQueue`, `queue`, `concurrencyKey`, `machinePreset`, `realtimeStreamsVersion`, `seedMetadata`, `seedMetadataType`, and `runTags`. Populated from the buffered run's engine-trigger snapshot. Also closes a pre-existing typecheck gap in `ApiRetrieveRunPresenter.synthesiseFoundRunFromBuffer` by surfacing `workerQueue` (defaulting to `"main"`) on the synthesised FoundRun.

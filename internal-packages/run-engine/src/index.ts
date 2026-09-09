export { RunEngine } from "./engine/index.js";
export {
  RunDuplicateIdempotencyKeyError,
  RunOneTimeUseTokenError,
  ServiceValidationError as EngineServiceValidationError,
  WaitpointCompletionGuardArmedError,
  isWaitpointCompletionGuardArmedError,
} from "./engine/errors.js";
export type { EventBusEventArgs, EventBusEvents } from "./engine/eventBus.js";
export { PARKED_ON_EXTERNAL_DEPLOYMENT_STATUS_REASON } from "./engine/systems/pendingVersionSystem.js";
export type { AuthenticatedEnvironment } from "./shared/index.js";
export type {
  PendingVersionRunIdLookup,
  PendingVersionRunIdLookupOptions,
  PendingVersionRunIdLookupResult,
} from "./engine/services/pendingVersionLookup.js";
export { NoopPendingVersionRunIdLookup } from "./engine/services/pendingVersionLookup.js";
export { readExternalDeploymentIdAnnotation } from "./engine/systems/pendingVersionSystem.js";
export { PassthroughControlPlaneResolver } from "./engine/controlPlaneResolver.js";
export type {
  ControlPlaneResolver,
  EnvDeletionState,
  ResolvedEngineEnv,
  ResolvedAuthenticatedEnv,
  ResolvedWorkerVersion,
  ResolvedWorkerTask,
  ResolvedTaskQueue,
  ResolvedWorkerDeployment,
} from "./engine/controlPlaneResolver.js";

// Batch Queue exports
export { BatchQueue, BatchCompletionTracker } from "./batch-queue/index.js";
export type {
  BatchQueueOptions,
  InitializeBatchOptions,
  CompleteBatchResult,
  BatchItem,
  BatchMeta,
  BatchItemFailure,
  BatchItemPayload,
  ProcessBatchItemCallback,
  BatchCompletionCallback,
} from "./batch-queue/types.js";

// Waitpoint store coordinator and its fanout worker. Exported but not yet wired: a later
// ticket routes WaitpointSystem onto them behind a per-organisation flag, and the worker
// stays disabled by default until then.
export {
  DEFAULT_TERMINAL_RETENTION_MS,
  WaitpointCompletionConflictError,
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
} from "./engine/waitpointCoordinator/storeCoordinator.js";
export type {
  AbsorbResult,
  BlockEdge,
  BlockState,
  BlockStateEdge,
  CleanupReason,
  CleanupResult,
  CompleteResult,
  CreateIfAbsentResult,
  DeliverResult,
  FanoutAckResult,
  FanoutBacklog,
  FanoutClaim,
  FanoutPageEntry,
  FanoutReleaseAction,
  FanoutReleaseResult,
  FanoutState,
  HandoffState,
  RegisterOrReportResult,
  WaitpointCompletion,
  WaitpointCompletionOutput,
  WaitpointDiagnostics,
  WaitpointRecordInput,
  WaitpointStatus,
  WaitpointStoreCoordinatorOptions,
  WatcherEntry,
} from "./engine/waitpointCoordinator/storeCoordinator.js";
export { WaitpointFanoutWorker } from "./engine/waitpointCoordinator/fanoutWorker.js";
export type {
  FanoutTickSummary,
  FanoutVisitSummary,
  FanoutWorkerHooks,
  WaitpointFanoutWorkerOptions,
} from "./engine/waitpointCoordinator/fanoutWorker.js";
export {
  assertFanoutWorkerLimits,
  completionFingerprint,
  DEFAULT_FANOUT_RETRY_POLICY,
} from "./engine/waitpointCoordinator/fanoutPolicy.js";
export type {
  FanoutRetryPolicy,
  FanoutWorkerLimits,
  WatcherDeliveryOutcome,
} from "./engine/waitpointCoordinator/fanoutPolicy.js";
export {
  FANOUT_PARTITION_COUNT,
  WaitpointKeyTagError,
} from "./engine/waitpointCoordinator/keys.js";

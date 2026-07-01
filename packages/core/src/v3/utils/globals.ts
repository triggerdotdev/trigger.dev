import type { ApiClientConfiguration } from "../apiClientManager/types.js";
import type { Clock } from "../clock/clock.js";
import type { HeartbeatsManager } from "../heartbeats/types.js";
import type { IdempotencyKeyCatalog } from "../idempotency-key-catalog/catalog.js";
import type { InputStreamManager } from "../inputStreams/types.js";
import type { SessionStreamManager } from "../sessionStreams/types.js";
import type { LifecycleHooksManager } from "../lifecycleHooks/types.js";
import type { LocalsManager } from "../locals/types.js";
import type { RealtimeStreamsManager } from "../realtimeStreams/types.js";
import type { ResourceCatalog } from "../resource-catalog/catalog.js";
import type { RunMetadataManager } from "../runMetadata/types.js";
import type { RuntimeManager } from "../runtime/manager.js";
import type { RunTimelineMetricsManager } from "../runTimelineMetrics/types.js";
import type { TaskContext } from "../taskContext/types.js";
import type { TimeoutManager } from "../timeout/types.js";
import type { TraceContextManager } from "../traceContext/types.js";
import type { UsageManager } from "../usage/types.js";
import type { WaitUntilManager } from "../waitUntil/types.js";
import { _globalThis } from "./platform.js";

const GLOBAL_TRIGGER_DOT_DEV_KEY = Symbol.for(`dev.trigger.ts.api`);

const _global = _globalThis as TriggerDotDevGlobal;

export function registerGlobal<Type extends keyof TriggerDotDevGlobalAPI>(
  type: Type,
  instance: TriggerDotDevGlobalAPI[Type],
  allowOverride = false
): boolean {
  const api = (_global[GLOBAL_TRIGGER_DOT_DEV_KEY] = _global[GLOBAL_TRIGGER_DOT_DEV_KEY] ?? {});

  if (!allowOverride && api[type]) {
    // already registered an API of this type
    const err = new Error(`trigger.dev: Attempted duplicate registration of API: ${type}`);
    return false;
  }

  api[type] = instance;

  return true;
}

export function getGlobal<Type extends keyof TriggerDotDevGlobalAPI>(
  type: Type
): TriggerDotDevGlobalAPI[Type] | undefined {
  return _global[GLOBAL_TRIGGER_DOT_DEV_KEY]?.[type];
}

export function unregisterGlobal(type: keyof TriggerDotDevGlobalAPI) {
  const api = _global[GLOBAL_TRIGGER_DOT_DEV_KEY];

  if (api) {
    delete api[type];
  }
}

type TriggerDotDevGlobal = {
  [GLOBAL_TRIGGER_DOT_DEV_KEY]?: TriggerDotDevGlobalAPI;
};

type TriggerDotDevGlobalAPI = {
  runtime?: RuntimeManager;
  logger?: any;
  clock?: Clock;
  usage?: UsageManager;
  ["resource-catalog"]?: ResourceCatalog;
  ["idempotency-key-catalog"]?: IdempotencyKeyCatalog;
  ["task-context"]?: TaskContext;
  ["api-client"]?: ApiClientConfiguration;
  ["run-metadata"]?: RunMetadataManager;
  ["timeout"]?: TimeoutManager;
  ["wait-until"]?: WaitUntilManager;
  ["run-timeline-metrics"]?: RunTimelineMetricsManager;
  ["lifecycle-hooks"]?: LifecycleHooksManager;
  ["locals"]?: LocalsManager;
  ["trace-context"]?: TraceContextManager;
  ["heartbeats"]?: HeartbeatsManager;
  ["realtime-streams"]?: RealtimeStreamsManager;
  ["input-streams"]?: InputStreamManager;
  ["session-streams"]?: SessionStreamManager;
};

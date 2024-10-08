import { DeserializedJson } from "../../schemas/json.js";
import { ApiClientConfiguration } from "../apiClientManager/types.js";
import { Clock } from "../clock/clock.js";
import type { RuntimeManager } from "../runtime/manager.js";
import { TaskCatalog } from "../task-catalog/catalog.js";
import { TaskContext } from "../taskContext/types.js";
import { UsageManager } from "../usage/types.js";
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
  ["task-catalog"]?: TaskCatalog;
  ["task-context"]?: TaskContext;
  ["api-client"]?: ApiClientConfiguration;
  ["run-metadata"]?: Record<string, DeserializedJson>;
};

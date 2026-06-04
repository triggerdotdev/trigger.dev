import {
  type ApiClientConfiguration,
  apiClientManager,
  sdkScope,
  type SdkScope,
} from "@trigger.dev/core/v3";
import "@trigger.dev/core/v3/sdk-scope-storage";

import { auth } from "./auth.js";
import { batch } from "./batch.js";
import { deployments } from "./deployments.js";
import * as envvarsModule from "./envvars.js";
import * as promptsModule from "./prompts.js";
import * as queuesModule from "./queues.js";
import { runs } from "./runs.js";
import * as schedulesModule from "./schedules/index.js";
import { batchTrigger, trigger } from "./shared.js";

export type TriggerClientConfig = ApiClientConfiguration & {
  /** Inherit ambient task context (parentRunId, lockToVersion, isTest) when called from inside a task. Default `false`. */
  inheritContext?: boolean;
};

const tasksApi = { trigger, batchTrigger };
const batchInstanceKeys = ["trigger", "triggerByTask", "retrieve"] as const;
const schedulesInstanceKeys = [
  "activate",
  "create",
  "deactivate",
  "del",
  "list",
  "retrieve",
  "update",
] as const;
const promptsInstanceKeys = [
  "createOverride",
  "list",
  "promote",
  "reactivateOverride",
  "removeOverride",
  "resolve",
  "updateOverride",
  "versions",
] as const;
const authInstanceKeys = [
  "createPublicToken",
  "createTriggerPublicToken",
  "createBatchTriggerPublicToken",
] as const;

type TasksApi = typeof tasksApi;
type RunsApi = typeof runs;
type BatchApi = Pick<typeof batch, (typeof batchInstanceKeys)[number]>;
type DeploymentsApi = typeof deployments;
type EnvvarsApi = typeof envvarsModule;
type PromptsApi = Pick<typeof promptsModule, (typeof promptsInstanceKeys)[number]>;
type QueuesApi = typeof queuesModule;
type SchedulesApi = Pick<typeof schedulesModule, (typeof schedulesInstanceKeys)[number]>;
type AuthApi = Pick<typeof auth, (typeof authInstanceKeys)[number]>;

export class TriggerClient {
  readonly tasks: TasksApi;
  readonly runs: RunsApi;
  readonly batch: BatchApi;
  readonly deployments: DeploymentsApi;
  readonly envvars: EnvvarsApi;
  readonly prompts: PromptsApi;
  readonly queues: QueuesApi;
  readonly schedules: SchedulesApi;
  readonly auth: AuthApi;

  constructor(config: TriggerClientConfig = {}) {
    const { inheritContext, ...partial } = config;
    const scope: SdkScope = {
      apiClientConfig: apiClientManager.resolveApiClientConfig(partial),
      inheritContext: inheritContext ?? false,
    };

    this.tasks = bindToScope(tasksApi, scope);
    this.runs = bindToScope(runs, scope);
    this.batch = bindToScope(batch, scope, batchInstanceKeys);
    this.deployments = bindToScope(deployments, scope);
    this.envvars = bindToScope(envvarsModule, scope);
    this.prompts = bindToScope(promptsModule, scope, promptsInstanceKeys);
    this.queues = bindToScope(queuesModule, scope);
    this.schedules = bindToScope(schedulesModule, scope, schedulesInstanceKeys);
    this.auth = bindToScope(auth, scope, authInstanceKeys);
  }
}

function bindToScope<T extends object, K extends keyof T = keyof T>(
  api: T,
  scope: SdkScope,
  keys?: readonly K[]
): Pick<T, K> {
  const targetKeys = (keys ?? (Object.keys(api) as K[])) as readonly K[];
  const bound: Record<string, unknown> = {};
  for (const key of targetKeys) {
    const value = (api as Record<string, unknown>)[key as string];
    bound[key as string] =
      typeof value === "function"
        ? (...args: unknown[]) =>
            sdkScope.withScope(scope, () => (value as (...a: unknown[]) => unknown)(...args))
        : value;
  }
  return bound as unknown as Pick<T, K>;
}

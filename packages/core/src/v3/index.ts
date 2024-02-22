import { TriggerTaskRequestBody } from "./schemas";

export * from "./schemas";
export * from "./apiClient";
export * from "./zodMessageHandler";
export * from "./errors";
export * from "./runtime-api";
export * from "./logger-api";
export { SemanticInternalAttributes } from "./semanticInternalAttributes";
export { iconStringForSeverity } from "./icons";
export {
  formatDuration,
  formatDurationMilliseconds,
  formatDurationNanoseconds,
  formatDurationInDays,
  nanosecondsToMilliseconds,
} from "./utils/durations";

export function parseTriggerTaskRequestBody(body: unknown) {
  return TriggerTaskRequestBody.safeParse(body);
}

export { taskContextManager, TaskContextSpanProcessor } from "./tasks/taskContextManager";
export type { RuntimeManager } from "./runtime/manager";
export { DevRuntimeManager } from "./runtime/devRuntimeManager";
export { TriggerTracer } from "./tracer";

export type { TaskLogger } from "./logger/taskLogger";
export { OtelTaskLogger } from "./logger/taskLogger";
export { ConsoleInterceptor } from "./consoleInterceptor";
export { flattenAttributes, unflattenAttributes } from "./utils/flattenAttributes";
export { defaultRetryOptions, calculateNextRetryTimestamp } from "./utils/retries";


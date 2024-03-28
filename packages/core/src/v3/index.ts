import { BatchTriggerTaskRequestBody, TriggerTaskRequestBody } from "./schemas";

export * from "./schemas";
export * from "./apiClient";
export * from "./zodMessageHandler";
export * from "./zodNamespace";
export * from "./zodSocket";
export * from "./zodIpc";
export * from "./errors";
export * from "./runtime-api";
export * from "./logger-api";
export * from "./clock-api";
export * from "./types";
export * from "./limits";
export { SemanticInternalAttributes } from "./semanticInternalAttributes";
export { iconStringForSeverity } from "./icons";
export {
  formatDuration,
  formatDurationMilliseconds,
  formatDurationNanoseconds,
  formatDurationInDays,
  nanosecondsToMilliseconds,
  millisecondsToNanoseconds,
} from "./utils/durations";
export { getEnvVar } from "./utils/getEnv";

export function parseTriggerTaskRequestBody(body: unknown) {
  return TriggerTaskRequestBody.safeParse(body);
}

export function parseBatchTriggerTaskRequestBody(body: unknown) {
  return BatchTriggerTaskRequestBody.safeParse(body);
}

export { taskContextManager, TaskContextSpanProcessor } from "./tasks/taskContextManager";
export type { RuntimeManager } from "./runtime/manager";
export { DevRuntimeManager } from "./runtime/devRuntimeManager";
export { ProdRuntimeManager } from "./runtime/prodRuntimeManager";
export { PreciseWallClock as DurableClock } from "./clock/preciseWallClock";
export { TriggerTracer } from "./tracer";

export type { TaskLogger } from "./logger/taskLogger";
export { OtelTaskLogger } from "./logger/taskLogger";
export { ConsoleInterceptor } from "./consoleInterceptor";
export {
  flattenAttributes,
  unflattenAttributes,
  primitiveValueOrflattenedAttributes,
} from "./utils/flattenAttributes";
export {
  defaultRetryOptions,
  defaultFetchRetryOptions,
  calculateNextRetryDelay,
  calculateResetAt,
} from "./utils/retries";
export { accessoryAttributes } from "./utils/styleAttributes";
export { eventFilterMatches } from "../eventFilterMatches";
export { omit } from "./utils/omit";
export { TracingSDK, type TracingDiagnosticLogLevel, recordSpanException } from "./otel";
export { TaskExecutor, type TaskExecutorOptions } from "./workers/taskExecutor";
export { detectDependencyVersion } from "./utils/detectDependencyVersion";
export {
  parsePacket,
  stringifyIO,
  prettyPrintPacket,
  createPacketAttributes,
  createPacketAttributesAsJson,
  conditionallyExportPacket,
  conditionallyImportPacket,
  packetRequiresOffloading,
  type IOPacket,
} from "./utils/ioSerialization";

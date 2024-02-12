import { TriggerTaskRequestBody } from "./schemas";

export * from "./schemas";
export * from "./apiClient";
export * from "./zodMessageHandler";
export * from "./errors";
export * from "./runtime-api";
export * from "./logger-api";
export { SemanticInternalAttributes } from "./semanticInternalAttributes";

export function parseTriggerTaskRequestBody(body: unknown) {
  return TriggerTaskRequestBody.safeParse(body);
}

export { taskContextManager } from "./tasks/taskContextManager";
export type { RuntimeManager } from "./runtime/manager";
export { DevRuntimeManager } from "./runtime/devRuntimeManager";
export { TriggerTracer } from "./tracer";

export type { TaskLogger } from "./logger/taskLogger";
export { OtelTaskLogger } from "./logger/taskLogger";
export { ConsoleInterceptor } from "./consoleInterceptor";
export { flattenAttributes } from "./utils/flattenAttributes";

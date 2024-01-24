import { TriggerTaskRequestBody } from "./schemas";

export * from "./schemas";
export * from "./apiClient";
export * from "./zodMessageHandler";
export * from "./errors";

export function parseTriggerTaskRequestBody(body: unknown) {
  return TriggerTaskRequestBody.safeParse(body);
}

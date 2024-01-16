import { TriggerTaskRequestBody } from "./schemas";

export * from "./schemas";
export * from "./apiClient";

export function parseTriggerTaskRequestBody(body: unknown) {
  return TriggerTaskRequestBody.safeParse(body);
}

import { WebhookPayload } from "./schemas";

export type ExtractCreate<T extends WebhookPayload> = Extract<T, { action: "create" }>;
export type ExtractRemove<T extends WebhookPayload> = Extract<T, { action: "remove" }>;
export type ExtractUpdate<T extends WebhookPayload> = Extract<T, { action: "update" }>;

import { WebhookActionType, WebhookPayload } from "./schemas";

export type GetLinearPayload<
  TPayload extends WebhookPayload,
  TAction extends any = any,
> = TAction extends WebhookActionType ? Extract<TPayload, { action: TAction }> : TPayload;

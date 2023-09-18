import { WebhookActionType, WebhookPayload } from "./schemas";

export type GetLinearPayload<
  TPayload extends WebhookPayload,
  TAction extends any = any,
> = TAction extends WebhookActionType ? Extract<TPayload, { action: TAction }> : TPayload;

type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never
}[keyof T]

export type WithoutFunctions<T> = T extends object
  ? T extends Array<infer U>
    ? Array<WithoutFunctions<U>>
    : { [K in keyof T as Exclude<K, FunctionKeys<T>>]: WithoutFunctions<T[K]> }
  : T
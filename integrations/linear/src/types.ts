import { Request } from "@linear/sdk";
import { WebhookActionType, WebhookPayload } from "./schemas";

export type GetLinearPayload<
  TPayload extends WebhookPayload,
  TAction extends any = any,
> = TAction extends WebhookActionType ? Extract<TPayload, { action: TAction }> : TPayload;

type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

export type SerializedLinearOutput<T> = T extends object
  ? T extends Array<infer U>
    ? Array<SerializedLinearOutput<U>>
    : { [K in keyof T as Exclude<K, FunctionKeys<T> | `_${string}`>]: SerializedLinearOutput<T[K]> }
  : T;

export type LinearReturnType<
  TPayload extends Omit<Request, "_request">,
  K extends unknown = unknown,
> = Promise<
  Awaited<SerializedLinearOutput<Awaited<K extends keyof TPayload ? TPayload[K] : TPayload>>>
>;

export type AwaitNested<T extends object, K extends keyof T> = Omit<T, K> & {
  [key in K]: Awaited<T[K]>;
};

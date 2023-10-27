import { Request } from "vercel";
import { WebhookEventType, WebhookPayload } from "./schemas";

export type GetVercelPayload<
  TPayload extends WebhookPayload,
  TEventType extends any = any,
> = TEventType extends WebhookEventType ? Extract<TPayload, { type: TEventType }> : TPayload;

type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

export type SerializedVercelOutput<T> = T extends object
  ? T extends Array<infer U>
    ? Array<SerializedVercelOutput<U>>
    : { [K in keyof T as Exclude<K, FunctionKeys<T> | `_${string}`>]: SerializedVercelOutput<T[K]> }
  : T;

export type VercelReturnType<
  TPayload extends Omit<Request, "_request">,
  K extends unknown = unknown,
> = Promise<
  Awaited<SerializedVercelOutput<Awaited<K extends keyof TPayload ? TPayload[K] : TPayload>>>
>;

export type AwaitNested<T extends object, K extends keyof T> = Omit<T, K> & {
  [key in K]: Awaited<T[K]>;
};

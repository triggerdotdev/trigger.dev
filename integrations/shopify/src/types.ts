import {
  ObjectNonNullable,
  OmitFunctions,
  OmitIndexSignature,
  Prettify,
} from "@trigger.dev/integration-kit";
import { ShopifyRestResources } from ".";

type OmitNonSerializable<T> = Omit<OmitFunctions<OmitIndexSignature<T>>, "session">;

export type SerializedShopifyResource<T> = Prettify<ObjectNonNullable<OmitNonSerializable<T>>>;

export type RecursiveShopifySerializer<T> = T extends object
  ? T extends Array<infer U>
    ? Array<RecursiveShopifySerializer<U>>
    : SerializedShopifyResource<T>
  : T;

export type ShopifyReturnType<
  TPayload extends Omit<Request, "_request">,
  K extends unknown = unknown,
> = Promise<
  Awaited<RecursiveShopifySerializer<Awaited<K extends keyof TPayload ? TPayload[K] : TPayload>>>
>;

export type AwaitNested<T extends object, K extends keyof T> = Omit<T, K> & {
  [key in K]: Awaited<T[K]>;
};

export type ShopifyResource<TResource extends keyof ShopifyRestResources> = InstanceType<
  ShopifyRestResources[TResource]
>;

export type ShopifyWebhookPayload = {
  [K in keyof OmitIndexSignature<ShopifyRestResources>]: Prettify<
    SerializedShopifyResource<ShopifyResource<K>>
  >;
};

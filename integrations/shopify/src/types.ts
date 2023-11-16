import {
  ObjectNonNullable,
  OmitFunctions,
  OmitIndexSignature,
  Prettify,
} from "@trigger.dev/integration-kit";
import { RestResources } from "@shopify/shopify-api/rest/admin/2023-10";

export type SerializedShopifyOutput<T> = T extends object
  ? T extends Array<infer U>
    ? Array<SerializedShopifyOutput<U>>
    : ObjectNonNullable<OmitFunctions<OmitIndexSignature<T>>>
  : T;

export type ShopifyReturnType<
  TPayload extends Omit<Request, "_request">,
  K extends unknown = unknown,
> = Promise<
  Awaited<SerializedShopifyOutput<Awaited<K extends keyof TPayload ? TPayload[K] : TPayload>>>
>;

export type AwaitNested<T extends object, K extends keyof T> = Omit<T, K> & {
  [key in K]: Awaited<T[K]>;
};

type Resource<TResource extends keyof RestResources> = InstanceType<RestResources[TResource]>;

// TODO: fix nested props + remove readonly
export type ShopifyWebhookPayload = {
  [K in keyof OmitIndexSignature<RestResources>]: Prettify<
    ObjectNonNullable<OmitFunctions<OmitIndexSignature<Resource<K>>>>
  >;
};

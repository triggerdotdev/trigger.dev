import {
  ObjectNonNullable,
  OmitFunctions,
  OmitIndexSignature,
  OmitValues,
  Prettify,
} from "@trigger.dev/integration-kit";
import { ShopifyRestResources } from "./index";

type OmitNonSerializable<T> = Omit<OmitFunctions<OmitIndexSignature<T>>, "session">;

export type SerializedShopifyResource<T, TNonNullable extends boolean = true> = Prettify<
  TNonNullable extends true ? ObjectNonNullable<OmitNonSerializable<T>> : OmitNonSerializable<T>
>;

export type RecursiveShopifySerializer<T, TNonNullable extends boolean = true> = T extends object
  ? T extends Array<infer U>
    ? Array<RecursiveShopifySerializer<U>>
    : SerializedShopifyResource<T, TNonNullable>
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

export type ShopifyInputType = {
  [K in keyof OmitIndexSignature<ShopifyRestResources>]: Prettify<
    Partial<SerializedShopifyResource<ShopifyResource<K>, false>>
  > & { id?: number };
};

type ResourceHasStandardMethods = {
  [K in keyof ShopifyRestResources]: "find" extends keyof ShopifyRestResources[K]
    ? ShopifyRestResources[K]["find"] extends (...args: any) => any
      ? Parameters<ShopifyRestResources[K]["find"]>[0] extends { id: string | number }
        ? "all" | "count" | "delete" extends keyof ShopifyRestResources[K]
          ? true
          : false
        : false
      : false
    : false;
};

export type ResourcesWithStandardMethods = keyof OmitValues<ResourceHasStandardMethods, false>;

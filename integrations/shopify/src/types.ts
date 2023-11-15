type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

export type SerializedShopifyOutput<T> = T extends object
  ? T extends Array<infer U>
    ? Array<SerializedShopifyOutput<U>>
    : {
        [K in keyof T as Exclude<K, FunctionKeys<T> | `_${string}`>]: SerializedShopifyOutput<T[K]>;
      }
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

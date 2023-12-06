import { PlainClient } from "@team-plain/typescript-sdk";
import { Prettify } from "@trigger.dev/integration-kit";

export type PlainSDK = InstanceType<typeof PlainClient>;

// T is a promise that resolves to a type like: { data: { id: string } | null; error: undefined } | { data: undefined; error: Error }
// GetPlainSuccessResponseData will return the type of the data property of the promise
type GetPlainSuccessResponseData<T> = T extends Promise<infer U>
  ? U extends { data: infer V }
    ? Prettify<ReplaceNullWithUndefined<RemoveTypename<V>>>
    : never
  : never;

// This generic will remove all the __typename properties from an object, recursively
export type RemoveTypename<T> = T extends object
  ? T extends Array<infer U>
    ? Array<RemoveTypename<U>>
    : { [K in keyof T as Exclude<K, "__typename">]: RemoveTypename<T[K]> }
  : T;

type ReplaceNullWithUndefined<T> = T extends null ? undefined : T;

export type GetCustomerByIdParams = Prettify<Parameters<PlainSDK["getCustomerById"]>[0]>;

export type GetCustomerByIdResponse = GetPlainSuccessResponseData<
  ReturnType<PlainSDK["getCustomerById"]>
>;

export type UpsertCustomerParams = Prettify<Parameters<PlainSDK["upsertCustomer"]>[0]>;

export type UpsertCustomerResponse = GetPlainSuccessResponseData<
  ReturnType<PlainSDK["upsertCustomer"]>
>;

export type UpsertCustomTimelineEntryParams = Prettify<
  Parameters<PlainSDK["upsertCustomTimelineEntry"]>[0]
>;

export type UpsertCustomTimelineEntryResponse = GetPlainSuccessResponseData<
  ReturnType<PlainSDK["upsertCustomTimelineEntry"]>
>;

export type { FetchRetryOptions, FetchTimeoutOptions } from "@trigger.dev/core";

export type ObjectNonNullable<T, TKeys extends keyof T = keyof T> = {
  [K in keyof T]: K extends TKeys ? NonNullable<T[K]> : T[K];
};

type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

export type OmitFunctions<T> = {
  [K in keyof T as Exclude<K, FunctionKeys<T>>]: T[K];
};

export type OmitIndexSignature<T> = {
  [K in keyof T as {} extends Record<K, unknown> ? never : K]: T[K];
};

type ObjectEntry<T> = [keyof T, T[keyof T]];

export type ObjectEntries<T> = Array<ObjectEntry<T>>;

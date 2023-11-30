export type { FetchRetryOptions, FetchTimeoutOptions } from "@trigger.dev/core";

export type Nullable<T> = T extends Record<string, any>
  ? {
      [K in keyof T]: T[K] | null;
    }
  : T | null;

export type ObjectNonNullable<T, TKeys extends keyof T = keyof T> = {
  [K in keyof T]: K extends TKeys ? NonNullable<T[K]> : T[K];
};

export type SomeNonNullable<T extends Record<any, any>, TSome extends keyof T> = {
  [K in keyof T]: K extends TSome ? NonNullable<T[K]> : T[K];
};

export type SomeNullable<T extends Record<any, any>, TSome extends keyof T> = {
  [K in keyof T]: K extends TSome ? T[K] | null : T[K];
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

export type OmitValues<TRecord extends Record<any, any>, TValue extends any> = {
  [K in keyof TRecord as TRecord[K] extends TValue ? never : K]: TRecord[K];
};

export type Optional<TRecord extends Record<any, any>, TOptional extends keyof TRecord> = Omit<
  TRecord,
  TOptional
> &
  Partial<Pick<TRecord, TOptional>>;

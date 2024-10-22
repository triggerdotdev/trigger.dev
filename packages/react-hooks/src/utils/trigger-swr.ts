"use client";
// eslint-disable-next-line import/export
export * from "swr";
// eslint-disable-next-line import/export
export { default as useSWR, SWRConfig } from "swr";

export type CommonTriggerHookOptions = {
  refreshInterval?: number;
  revalidateOnReconnect?: boolean;
  revalidateOnFocus?: boolean;
};

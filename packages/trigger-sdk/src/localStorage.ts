import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  FetchOptions,
  FetchResponse,
  TriggerCustomEvent,
  TriggerFetch,
} from "./types";

type PerformRequestOptions<TSchema extends z.ZodTypeAny> = {
  service: string;
  params: unknown;
  endpoint: string;
  response: {
    schema: TSchema;
  };
};

type TriggerRunLocalStorage = {
  performRequest: <TSchema extends z.ZodTypeAny>(
    key: string,
    options: PerformRequestOptions<TSchema>
  ) => Promise<z.infer<TSchema>>;
  sendEvent: (key: string, event: TriggerCustomEvent) => Promise<void>;
  fetch: TriggerFetch;
};

export const triggerRunLocalStorage =
  new AsyncLocalStorage<TriggerRunLocalStorage>();

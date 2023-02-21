import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { TriggerCustomEvent, TriggerFetch } from "./types";

type PerformRequestOptions<TSchema extends z.ZodTypeAny> = {
  version?: string;
  service: string;
  params: unknown;
  endpoint: string;
  response?: {
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
  workflowId: string;
  appOrigin: string;
  id: string;
};

export const triggerRunLocalStorage =
  new AsyncLocalStorage<TriggerRunLocalStorage>();

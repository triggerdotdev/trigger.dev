import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

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
    options: PerformRequestOptions<TSchema>
  ) => Promise<z.infer<TSchema>>;
};

export const triggerRunLocalStorage =
  new AsyncLocalStorage<TriggerRunLocalStorage>();

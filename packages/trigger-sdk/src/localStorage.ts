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

type PerformRequestResponse<TSchema extends z.ZodTypeAny> = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: z.infer<TSchema>;
};

type TriggerRunLocalStorage = {
  performRequest: <TSchema extends z.ZodTypeAny>(
    options: PerformRequestOptions<TSchema>
  ) => Promise<PerformRequestResponse<TSchema>>;
};

export const triggerRunLocalStorage =
  new AsyncLocalStorage<TriggerRunLocalStorage>();

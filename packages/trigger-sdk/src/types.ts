import {
  SerializableCustomEventSchema,
  SerializableJsonSchema,
  SecureString,
} from "@trigger.dev/common-schemas";
import { z } from "zod";

export type { SecureString };

export type TriggerCustomEvent = z.infer<typeof SerializableCustomEventSchema>;

export type WaitForOptions = {
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
};

export type FetchOptions<
  TResponseBodySchema extends z.ZodTypeAny = z.ZodTypeAny
> = {
  method:
    | "GET"
    | "POST"
    | "PUT"
    | "DELETE"
    | "PATCH"
    | "HEAD"
    | "OPTIONS"
    | "TRACE";
  body?: z.infer<typeof SerializableJsonSchema>;
  headers?: Record<string, string | SecureString>;
  responseSchema?: TResponseBodySchema;
};

export type FetchResponse<
  TResponseBodySchema extends z.ZodTypeAny = z.ZodTypeAny
> = {
  ok: boolean;
  body?: z.infer<TResponseBodySchema>;
  headers: Record<string, string>;
  status: number;
};

export interface TriggerContext {
  id: string;
  environment: string;
  apiKey: string;
  organizationId: string;
  logger: TriggerLogger;
  sendEvent(key: string, event: TriggerCustomEvent): Promise<void>;
  waitFor(key: string, options: WaitForOptions): Promise<void>;
  waitUntil(key: string, date: Date): Promise<void>;
  fetch<TBodySchema extends z.ZodTypeAny = z.ZodTypeAny>(
    key: string,
    url: string | URL,
    options: FetchOptions<TBodySchema>
  ): Promise<FetchResponse<TBodySchema>>;
}

export interface TriggerLogger {
  debug(message: string, properties?: Record<string, any>): Promise<void>;
  info(message: string, properties?: Record<string, any>): Promise<void>;
  warn(message: string, properties?: Record<string, any>): Promise<void>;
  error(message: string, properties?: Record<string, any>): Promise<void>;
}

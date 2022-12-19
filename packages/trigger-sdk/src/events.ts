import { z } from "zod";

export type TriggerEvent<TEventData = unknown> = {
  type: "CUSTOM_EVENT" | "HTTP_ENDPOINT" | "SCHEDULE" | "WEBHOOK";
  config: any;
};

export type TriggerCustomEventOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
};

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerCustomEventOptions<TSchema>
): TriggerEvent<z.infer<TSchema>> {
  return {
    type: "CUSTOM_EVENT",
    config: options,
  };
}

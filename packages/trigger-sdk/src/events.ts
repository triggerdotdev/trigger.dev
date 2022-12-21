import { z } from "zod";

export type TriggerEvent<TSchema extends z.ZodTypeAny> = {
  type: "CUSTOM_EVENT" | "HTTP_ENDPOINT" | "SCHEDULE" | "WEBHOOK";
  config: any;
  schema: TSchema;
};

export type TriggerCustomEventOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
};

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerCustomEventOptions<TSchema>
): TriggerEvent<TSchema> {
  return {
    type: "CUSTOM_EVENT",
    config: { name: options.name },
    schema: options.schema,
  };
}

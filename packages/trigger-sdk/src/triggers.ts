import { z } from "zod";

export type Trigger<TEventData = void> = {
  type: "CUSTOM_EVENT" | "HTTP_ENDPOINT" | "SCHEDULE" | "WEBHOOK";
  config: any;
};

export type EventTriggerOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
};

export function onEvent<TSchema extends z.ZodTypeAny>(
  options: EventTriggerOptions<TSchema>
): Trigger<z.infer<TSchema>> {
  return {
    type: "CUSTOM_EVENT",
    config: options,
  };
}

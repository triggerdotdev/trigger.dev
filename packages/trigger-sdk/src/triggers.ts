import { z } from "zod";

export type Trigger<TEventData = void> = {
  id: string;
};

export type EventTriggerOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
};

export function onEvent<TSchema extends z.ZodTypeAny>(
  options: EventTriggerOptions<TSchema>
): Trigger<z.infer<TSchema>> {
  return {
    id: options.name,
  };
}

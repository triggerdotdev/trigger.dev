import type { z } from "zod";

export function formDataAsObject<TValues>(
  formData: FormData,
  schema: z.ZodSchema<TValues>
): TValues {
  const object = Object.fromEntries(formData.entries());
  const parsed = schema.parse(object);
  return parsed;
}

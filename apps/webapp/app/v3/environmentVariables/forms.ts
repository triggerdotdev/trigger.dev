import { parseWithZod } from "@conform-to/zod/v4";
import { configureCoercion } from "@conform-to/zod/v4/future";
import type { z } from "zod";
import { EnvironmentVariableValue } from "./repository";

function formCoercion(allowEmptyValues: boolean) {
  return configureCoercion({
    // Preserve only the value field; other fields keep Conform's normal coercion.
    customize: (schema) =>
      schema === EnvironmentVariableValue
        ? (value) =>
            !allowEmptyValues && typeof value === "string" && value.trim() === ""
              ? undefined
              : value
        : null,
  });
}

export function parseEnvironmentVariableForm<Schema extends z.ZodType>(
  formData: FormData,
  schema: Schema,
  allowEmptyValues = true
) {
  const { coerceFormValue } = formCoercion(allowEmptyValues);
  return parseWithZod(formData, {
    schema: coerceFormValue(schema),
    disableAutoCoercion: true,
  });
}

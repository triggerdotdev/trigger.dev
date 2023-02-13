import { Validator } from "@cfworker/json-schema";
import { JSONSchema } from "./types";

export function validate(data: any, schema?: JSONSchema) {
  if (!schema) {
    return {
      success: true as const,
    };
  }
  const validator = new Validator(schema);
  const result = validator.validate(data);
  if (!result.valid) {
    return {
      success: false as const,
      errors: result.errors,
    };
  }

  return {
    success: true as const,
  };
}

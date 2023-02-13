import { JSONSchema } from "./types";

export async function validate(data: any, schema?: JSONSchema) {
  if (!schema) {
    return {
      success: true as const,
    };
  }
  const Validator = await getValidator();
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

async function getValidator() {
  const tool = await import("@cfworker/json-schema");
  return tool.Validator;
}

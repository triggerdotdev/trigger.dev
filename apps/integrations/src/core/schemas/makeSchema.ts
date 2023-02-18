import { JSONSchema } from "./types";

export function makeStringSchema(
  title?: string,
  options?: {
    defaultValue: string;
  }
): JSONSchema {
  return {
    type: "string",
    title,
    default: options?.defaultValue,
  };
}

export function makeNumberSchema(
  title?: string,
  options?: {
    defaultValue: number;
  }
): JSONSchema {
  return {
    type: "number",
    title,
    default: options?.defaultValue,
  };
}

export function makeBooleanSchema(
  title?: string,
  options?: {
    defaultValue: boolean;
  }
): JSONSchema {
  return {
    type: "boolean",
    title,
    default: options?.defaultValue,
  };
}

export function makeArraySchema(title: string, items: JSONSchema): JSONSchema {
  return {
    type: "array",
    title,
    items,
  };
}

export function makeObjectSchema(
  title: string,
  options: {
    optionalProperties?: Record<string, JSONSchema>;
    requiredProperties?: Record<string, JSONSchema>;
    additionalProperties?: boolean | JSONSchema;
  }
): JSONSchema {
  return {
    type: "object",
    title,
    properties: {
      ...options.optionalProperties,
      ...options.requiredProperties,
    },
    required: options.requiredProperties
      ? Object.keys(options.requiredProperties)
      : undefined,
    additionalProperties: options.additionalProperties,
  };
}

export function makeUnion(title: string, schemas: JSONSchema[]): JSONSchema {
  return {
    title,
    oneOf: schemas,
  };
}

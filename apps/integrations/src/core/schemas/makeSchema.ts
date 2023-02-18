import { JSONSchema } from "./types";

export function makeStringSchema(
  title?: string,
  options?: {
    defaultValue?: string;
    enum?: string[];
  }
): JSONSchema {
  return {
    type: "string",
    title,
    default: options?.defaultValue,
    enum: options?.enum,
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
  let properties: Record<string, JSONSchema> | undefined = undefined;

  if (options.optionalProperties || options.requiredProperties) {
    properties = {};
  }

  if (options.optionalProperties) {
    properties = {
      ...properties,
      ...options.optionalProperties,
    };
  }

  if (options.requiredProperties) {
    properties = {
      ...properties,
      ...options.requiredProperties,
    };
  }

  return {
    type: "object",
    title,
    properties,
    required: options.requiredProperties
      ? Object.keys(options.requiredProperties)
      : undefined,
    additionalProperties: options.additionalProperties,
  };
}

export function makeOneOf(title: string, schemas: JSONSchema[]): JSONSchema {
  return {
    title,
    oneOf: schemas,
  };
}

export function makeAnyOf(title: string, schemas: JSONSchema[]): JSONSchema {
  return {
    title,
    anyOf: schemas,
  };
}

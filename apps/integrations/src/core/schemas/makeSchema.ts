import { JSONSchema, JSONSchemaInstanceType } from "./types";

export function makeStringSchema(
  title: string,
  description?: string,
  options?: {
    defaultValue?: string;
    const?: string;
    enum?: string[];
  }
): JSONSchema {
  const schema: JSONSchema = {
    type: "string",
    title,
  };

  if (description) {
    schema.description = description;
  }

  if (options?.defaultValue) {
    schema.default = options.defaultValue;
  }

  if (options?.enum) {
    schema.enum = options.enum;
  }

  if (options?.const) {
    schema.const = options.const;
  }

  return schema;
}

export function makeNumberSchema(
  title: string,
  description?: string,
  options?: {
    defaultValue: number;
  }
): JSONSchema {
  const schema: JSONSchema = {
    type: "number",
    title,
  };

  if (description) {
    schema.description = description;
  }

  if (options?.defaultValue) {
    schema.default = options.defaultValue;
  }

  return schema;
}

export function makeBooleanSchema(
  title: string,
  description?: string,
  options?: {
    defaultValue?: boolean;
    enum?: boolean;
    const?: boolean;
  }
): JSONSchema {
  const schema: JSONSchema = {
    title,
    type: "boolean",
  };

  if (description) {
    schema.description = description;
  }

  if (options?.defaultValue) {
    schema.default = options.defaultValue;
  }

  if (options?.enum) {
    schema.enum = [options.enum];
  }

  if (options?.const) {
    schema.const = options.const;
  }

  return schema;
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

export function makeRecordSchema(
  title: string,
  schema: JSONSchema
): JSONSchema {
  return {
    type: "object",
    title,
    additionalProperties: schema,
  };
}

export function makeNull(): JSONSchema {
  return {
    type: "null",
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

export function makeNullable(schema: JSONSchema): JSONSchema {
  //if there's no existing type then we need to create an anyOf with null
  if (!schema.type) {
    return {
      title: schema.title,
      description: schema.description,
      anyOf: [
        {
          type: "null",
        },
        schema,
      ],
    };
  }

  //if there is a type then we can add the "null" type to it
  let combinedTypes: JSONSchemaInstanceType[] = [];
  switch (typeof schema.type) {
    case "string":
      combinedTypes = [schema.type, "null"];
      break;
    case "object":
      combinedTypes = [...schema.type, "null"];
      break;
    default:
      throw new Error(`Invalid schema type: ${typeof schema.type}`);
  }

  return {
    ...schema,
    type: combinedTypes,
  };
}

export function makeAllPropertiesOptional(schema: JSONSchema): JSONSchema {
  if (schema.type !== "object") {
    throw new Error("Schema must be an object");
  }

  if (!schema.properties) {
    throw new Error("Schema must have properties");
  }

  return {
    ...schema,
    required: [],
  };
}

export function makePropertiesOptional(
  schema: JSONSchema,
  properties: string[]
): JSONSchema {
  if (schema.type !== "object") {
    throw new Error("Schema must be an object");
  }

  if (!schema.properties) {
    throw new Error("Schema must have properties");
  }

  return {
    ...schema,
    required: schema.required?.filter((p) => !properties.includes(p)),
  };
}

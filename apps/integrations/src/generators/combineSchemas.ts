import { Action } from "core/action/types";
import { JSONSchema } from "core/schemas/types";

export function generateInputOutputSchemas(
  spec: Action["spec"],
  name: string
): {
  input: JSONSchema | undefined;
  output: JSONSchema | undefined;
} {
  const inputSchema = createInputSchema(spec.input);
  if (inputSchema) inputSchema.title = `${name}Input`;

  const outputSchema = createSuccessfulOutputSchema(spec.output);
  if (outputSchema) outputSchema.title = `${name}Output`;

  return {
    input: inputSchema,
    output: outputSchema,
  };
}

export function createInputSchema(
  spec: Action["spec"]["input"]
): JSONSchema | undefined {
  if (
    (spec.parameters === undefined || spec.parameters.length === 0) &&
    spec.body === undefined
  )
    return undefined;

  const inputSchema: JSONSchema = {
    allOf: [],
  };

  if (spec.body) {
    inputSchema.allOf?.push(spec.body);
  }

  if (spec.parameters && spec.parameters.length > 0) {
    const paramsSchema: JSONSchema = {
      type: "object",
      properties: {
        ...Object.fromEntries(
          spec.parameters.map((p) => [
            p.name,
            { ...p.schema, description: p.description },
          ])
        ),
      },
      required: [
        ...spec.parameters.filter((p) => p.required).map((p) => p.name),
      ],
    };

    inputSchema.allOf?.push(paramsSchema);
  }

  return inputSchema;
}

export function createSuccessfulOutputSchema(
  spec: Action["spec"]["output"]
): JSONSchema | undefined {
  if (spec === undefined) return undefined;

  //combine all "success" output schemas into a union
  const outputSuccessSchemas = spec.responses.flatMap((r) =>
    r.success ? r.schema : []
  );

  return outputSuccessSchemas.length === 1
    ? outputSuccessSchemas[0]
    : createDiscriminatedUnionSchema(`Output`, outputSuccessSchemas);
}

function createDiscriminatedUnionSchema(
  name: string,
  schemas: JSONSchema[]
): JSONSchema {
  return {
    $id: name,
    oneOf: schemas,
  };
}

import { Action } from "core/action/types";
import { JSONSchema } from "core/schemas/types";

export function generateInputOutputSchemas(
  spec: Action["spec"],
  name: string
): {
  input: JSONSchema | undefined;
  output: JSONSchema;
} {
  const inputSchema = createInputSchema(spec.input);
  if (inputSchema) inputSchema.title = `${name}Input`;

  const outputSchema = createSuccessfulOutputSchema(spec.output);
  outputSchema.title = `${name}Output`;

  return {
    input: inputSchema,
    output: outputSchema,
  };
}

export function createInputSchema(
  spec: Action["spec"]["input"]
): JSONSchema | undefined {
  let inputSchema: JSONSchema | undefined = spec.body;

  if (spec.parameters && spec.parameters.length > 0) {
    if (!inputSchema) {
      inputSchema = {
        type: "object",
        properties: {},
      };
    }

    inputSchema = {
      type: "object",
      properties: {
        ...inputSchema.properties,
        ...Object.fromEntries(
          spec.parameters.map((p) => [
            p.name,
            { ...p.schema, description: p.description },
          ])
        ),
      },
      required: [
        ...(inputSchema.required ?? []),
        ...spec.parameters.filter((p) => p.required).map((p) => p.name),
      ],
    };
  }

  return inputSchema;
}

export function createSuccessfulOutputSchema(
  spec: Action["spec"]["output"]
): JSONSchema {
  //combine all "success" output schemas into a union
  const outputSuccessSchemas = Object.values(spec.responses).flatMap((s) =>
    s.flatMap((r) => (r.success ? r.schema : []))
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

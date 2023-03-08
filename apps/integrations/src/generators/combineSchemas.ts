import { Action } from "core/action/types";
import { makeAnyOf } from "core/schemas/makeSchema";
import { SchemaRefWalker } from "core/schemas/schemaRefWalker";
import { JSONSchema } from "core/schemas/types";
import nodeObjectHash from "node-object-hash";
import pointer from "json-pointer";

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

  if (spec.body) {
    inputSchema.allOf?.push(spec.body);
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

const hasher = nodeObjectHash({ sort: true });

export function combineSchemasAndHoistReferences(
  name: string,
  schemas: JSONSchema[]
): JSONSchema {
  const definitions = new Map<string, JSONSchema>();

  schemas.forEach((s) => {
    const walker = new SchemaRefWalker(s);
    walker.run(s, ({ definition, ref, setRef }) => {
      const existing = definitions.get(ref);
      if (existing) {
        if (existing && hasher.hash(existing) !== hasher.hash(definition)) {
          console.log(
            "duplicate definition with different hash, inventing a new name"
          );
          for (let index = 0; index < 50; index++) {
            const newName = `${ref}${index}`;
            if (!definitions.has(newName)) {
              definitions.set(newName, definition);
              setRef(newName);
              break;
            }
          }
        } else {
          definitions.set(ref, definition);
        }
      } else {
        definitions.set(ref, definition);
      }
    });
  });

  const combinedSchema = makeAnyOf(name, schemas);

  //add all of the definitions, using their paths
  definitions.forEach((definition, ref) => {
    pointer.set(combinedSchema, ref.replace("#", ""), definition);
  });

  return combinedSchema;
}

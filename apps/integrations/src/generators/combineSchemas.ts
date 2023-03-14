import { makeAnyOf } from "core/schemas/makeSchema";
import { SchemaRefWalker } from "core/schemas/schemaRefWalker";
import { JSONSchema, SchemaRef } from "core/schemas/types";
import pointer from "json-pointer";
import nodeObjectHash from "node-object-hash";

/** Creates the smallest schema with only the used references */
export function createMinimalSchema(
  ref: SchemaRef,
  definitions: Record<string, JSONSchema>
): JSONSchema {
  const refWalker = new SchemaRefWalker({ definitions });

  //we want the schema to have the top-level ref expanded (for the zod generator)
  const rootObject = pointer.get({ definitions }, ref.replace("#", ""));

  const schema = {
    ...rootObject,
    definitions: {},
  };

  refWalker.run(schema, ({ object, key, ref, definition, seenBefore }) => {
    if (seenBefore) {
      return;
    }
    pointer.set(schema, ref.replace("#", ""), definition);
  });

  return schema;
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

import { SchemaRefWalker } from "core/schemas/schemaRefWalker";
import { JSONSchema, SchemaRef } from "core/schemas/types";
import pointer from "json-pointer";

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

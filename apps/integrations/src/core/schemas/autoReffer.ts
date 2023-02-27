import { JSONSchema } from "./types";
import nodeObjectHash from "node-object-hash";
import pointer from "json-pointer";

type JSONPointer = string[];
const hasher = nodeObjectHash({ sort: true });

export class AutoReffer {
  #schemaPointers = new Map<string, JSONPointer[]>();
  #schema: JSONSchema;

  constructor(schema: JSONSchema) {
    this.#schema = schema;
  }

  optimize() {
    this.#walk(this.#schema, []);
    console.log(this.#schemaPointers);
    const optimizedSchema = this.#addRefs();
    return optimizedSchema;
  }

  #walk(schema: JSONSchema, pointer: JSONPointer) {
    if (schema.type === "object") {
      const hash = hasher.hash(schema);
      const existingPath = this.#schemaPointers.get(hash);
      if (existingPath) {
        existingPath.push(pointer);
      } else {
        this.#schemaPointers.set(hash, [pointer]);
      }
    }

    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (typeof value === "boolean") continue;
        this.#walk(value, [...pointer, "properties", key]);
      }
    }

    if (schema.items) {
      if (typeof schema.items === "boolean") return;
      this.#walk(schema.items, [...pointer, "items"]);
    }

    if (schema.additionalProperties) {
      if (typeof schema.additionalProperties === "boolean") return;
      this.#walk(schema.additionalProperties, [
        ...pointer,
        "additionalProperties",
      ]);
    }

    if (schema.allOf) {
      schema.allOf.forEach((item, index) => {
        this.#walk(item, [...pointer, "allOf", `${index}`]);
      });
    }

    if (schema.anyOf) {
      schema.anyOf.forEach((item, index) => {
        this.#walk(item, [...pointer, "anyOf", `${index}`]);
      });
    }

    if (schema.oneOf) {
      schema.oneOf.forEach((item, index) => {
        this.#walk(item, [...pointer, "oneOf", `${index}`]);
      });
    }
  }

  #addRefs(): JSONSchema {
    const newSchema: JSONSchema = JSON.parse(JSON.stringify(this.#schema));
    //create definitions structure if it doesn't exist
    if (!newSchema.definitions) {
      newSchema.definitions = {};
    }
    //loop through the schemaPaths
    for (const [hash, pointers] of this.#schemaPointers) {
      if (pointers.length <= 1) continue;
      //create the ref
      const originalObject = pointer.get(newSchema, pointers[0]);
      const name = this.#inventName(pointers);
      const ref = `#/definitions/${name}`;
      newSchema.definitions[name] = originalObject;

      //loop through the pointers and add the ref
      for (const ptr of pointers) {
        pointer.set(newSchema, ptr, { $ref: ref });
      }
    }

    return newSchema;
  }

  #inventName(pointers: JSONPointer[]): string {
    const lastSegments = pointers.map((pointer) => pointer[pointer.length - 1]);
    const mostCommon = mode(lastSegments);
    return mostCommon ?? lastSegments[0];
  }
}

function mode(arr: string[]) {
  return arr
    .sort(
      (a, b) =>
        arr.filter((v) => v === a).length - arr.filter((v) => v === b).length
    )
    .pop();
}

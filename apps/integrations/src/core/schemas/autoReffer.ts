import { JSONSchema } from "./types";
import nodeObjectHash from "node-object-hash";
import pointer from "json-pointer";

type JSONPointer = string[];
const hasher = nodeObjectHash({ sort: true });

type Options = {
  refIfMoreThan: number;
};

export class AutoReffer {
  #schemaPointers = new Map<string, JSONPointer[]>();
  #schema: JSONSchema;
  #options: Options;

  constructor(schema: JSONSchema, options: Options = { refIfMoreThan: 2 }) {
    this.#schema = schema;
    this.#options = options;
  }

  optimize() {
    this.#walk(this.#schema, []);
    const optimizedSchema = this.#addRefs();
    return optimizedSchema;
  }

  #walk(schema: JSONSchema, pointer: JSONPointer) {
    if (schema.type === "object" || (schema.type === "string" && schema.enum)) {
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
      if (pointers.length < this.#options.refIfMoreThan) continue;
      //create the ref
      try {
        const originalObject = pointer.get(newSchema, pointers[0]);
        const name = this.#inventName(pointers, newSchema);
        const ref = `#/definitions/${name}`;
        newSchema.definitions[name] = originalObject;

        //loop through the pointers and add the ref
        for (const ptr of pointers) {
          pointer.set(newSchema, ptr, { $ref: ref });
        }
      } catch (e) {
        // console.log(e);
      }
    }

    return newSchema;
  }

  #inventName(pointers: JSONPointer[], schema: JSONSchema): string {
    const candidates: string[] = [];
    for (const ptr of pointers) {
      try {
        const object = pointer.get(schema, ptr);
        if (object.title) {
          candidates.push(object.title);
        }
      } catch (e) {
        //
      }
    }

    if (candidates.length > 0) {
      const mostCommon = mode(candidates);
      if (mostCommon) return toTitleCase(mostCommon);
    }

    const lastSegments = pointers.map((pointer) => pointer[pointer.length - 1]);
    const mostCommon = mode(lastSegments);
    return toTitleCase(mostCommon ?? lastSegments[0]);
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

//remove spaces and convert to TitleCase, deal with single words
function toTitleCase(str: string) {
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

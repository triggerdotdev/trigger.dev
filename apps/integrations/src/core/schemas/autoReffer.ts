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

    //turn the map into an array of [hash, pointers]
    const schemaPaths = Array.from(this.#schemaPointers.entries());

    //filter out the ones that are not used more than the threshold
    const filteredSchemaPaths = schemaPaths.filter(
      ([hash, pointers]) => pointers.length >= this.#options.refIfMoreThan
    );

    //now flatten it to an array of pointers with name
    const names = new Set<string>();
    const pointers = filteredSchemaPaths.flatMap(([hash, pointers]) => {
      //the name must be unique
      const name = this.#inventName(pointers, newSchema, names);
      return pointers.map((p) => ({
        pointer: p,
        name: name,
      }));
    });

    //now we want to sort them by their path, so we start out with the deepest ones in the tree
    const sortedPointers = pointers.sort((a, b) => {
      return b.pointer.join("/").localeCompare(a.pointer.join("/"));
    });

    for (let index = 0; index < sortedPointers.length; index++) {
      const element = sortedPointers[index];
      try {
        const originalObject = pointer.get(newSchema, element.pointer);
        const ref = `#/definitions/${element.name}`;
        newSchema.definitions[element.name] = originalObject;

        //set the ref
        pointer.set(newSchema, element.pointer, { $ref: ref });
      } catch (e) {
        //
      }
    }

    return newSchema;
  }

  #inventName(
    pointers: JSONPointer[],
    schema: JSONSchema,
    names: Set<string>
  ): string {
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
      if (mostCommon) {
        const name = toTitleCase(mostCommon);
        if (!names.has(name)) {
          names.add(name);
          return name;
        }

        //if the name is already taken, we need to add a number to it
        let i = 1;
        while (names.has(`${name}${i}`)) {
          i++;
        }
        names.add(`${name}${i}`);
        return `${name}${i}`;
      }
    }

    //failing finding a title we can look at the path and try create a name from that
    const namesFromPointer = pointers.map((ptr) =>
      findAppropriateNameFromPointer(ptr)
    );

    const mostCommon = mode(namesFromPointer);
    const name = toTitleCase(mostCommon ?? namesFromPointer[0]);
    if (!names.has(name)) {
      names.add(name);
      return name;
    }

    //if the name is already taken, we need to add a number to it
    let i = 1;
    while (names.has(`${name}${i}`)) {
      i++;
    }
    names.add(`${name}${i}`);
    return `${name}${i}`;
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

function nameIsJustNumbers(name: string | undefined) {
  if (!name) return false;
  return /^\d+$/.test(name);
}

function findAppropriateNameFromPointer(pointer: JSONPointer): string {
  //start with the last segment and loop backwards
  for (let i = pointer.length - 1; i >= 0; i--) {
    const name = pointer[i];

    if (name === "anyOf" || name === "oneOf" || name === "allOf") {
      continue;
    }

    //check if the segment is a number, if so we need to look at the previous segment
    if (!nameIsJustNumbers(name)) {
      return name;
    }
  }

  return "Item";
}

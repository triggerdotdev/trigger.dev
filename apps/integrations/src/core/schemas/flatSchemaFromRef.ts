import pointer from "json-pointer";
import { JSONSchema } from "./types";

export function flatSchemaFromRef(spec: any, ref: string): JSONSchema {
  //starting point
  const path = ref.replace("#", "");
  try {
    const object = pointer.get(spec, path);
    const newSpec = JSON.parse(JSON.stringify(object));

    //walk through the object and deref anything that needs it (then recursively do this)
    const deReffer = new Dereffer(spec);
    deReffer.run(newSpec);

    return newSpec;
  } catch (e) {
    console.log(spec);
    console.error("e", e);
    return spec;
  }
}

class Dereffer {
  spec: any;
  stack: any[];
  refsExplored: Map<string, any>;

  constructor(spec: any) {
    this.spec = spec;
    this.stack = [];
    this.refsExplored = new Map();
  }

  run(object: any) {
    this.stack.push(object);
    this.#walk();
  }

  #walk() {
    while (this.stack.length > 0) {
      const object = this.stack.pop();
      if (object == null) continue;
      if (typeof object !== "object") continue;

      if (object.$ref) {
        const path = (object.$ref as string).replace("#", "");

        if (!this.refsExplored.has(path)) {
          const ptr = pointer.get(this.spec, path);
          if (ptr === undefined) {
            throw new Error(`Invalid reference: ${object.$ref}`);
          }

          Object.assign(object, ptr);
          delete object.$ref;

          this.refsExplored.set(path, ptr);
        } else {
          const ptr = this.refsExplored.get(path);
          Object.assign(object, ptr);
          delete object.$ref;
        }
      }

      Object.entries(object).forEach(([key, value]) => {
        if (key === "$ref") {
          return;
        }

        if (typeof value === "object") {
          if (Array.isArray(value)) {
            value.forEach((item: any) => {
              this.stack.push(item);
            });
          } else {
            this.stack.push(value);
          }
        }
      });
    }
  }
}

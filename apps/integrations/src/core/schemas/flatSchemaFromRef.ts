import pointer from "json-pointer";
import { JSONSchema } from "./types";

export function flatSchemaFromRef(spec: any, ref: string): JSONSchema {
  //starting point
  const path = ref.replace("#", "");
  const object = pointer.get(spec, path);
  const newSpec = JSON.parse(JSON.stringify(object));

  //walk through the object and deref anything that needs it (then recursively do this)
  deReffer(spec, newSpec);

  return newSpec;
}

function deReffer(spec: any, object: any) {
  //walk through the object. If there is a key called "$ref" then replace it with the referenced object
  //if the object has anyOf, oneOf or allOf then we need to deReffer each of those
  //if the object has properties then we need to deReffer each of those
  //if the object has items then we need to deReffer that
  //if the object has additionalProperties then we need to deReffer that
  //if the object has a type of "object" then we need to deReffer that

  Object.entries(object).forEach(([key, value]) => {
    if (key === "$ref") {
      const path = (value as string).replace("#", "");
      const ptr = pointer.get(spec, path);
      if (ptr === undefined) {
        throw new Error(`Invalid reference: ${value}`);
      }

      Object.assign(object, ptr);
      delete object.$ref;

      //because we've modified the object, we need to re-run the loop
      deReffer(spec, object);
    }

    if (typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((item: any) => {
          deReffer(spec, item);
        });
      } else {
        deReffer(spec, value);
      }
    }
  });
}

import pointer from "json-pointer";

export function deReffer(spec: any, object?: any) {
  //walk through the object. If there is a key called "$ref" then replace it with the referenced object
  //if the object has anyOf, oneOf or allOf then we need to deReffer each of those
  //if the object has properties then we need to deReffer each of those
  //if the object has items then we need to deReffer that
  //if the object has additionalProperties then we need to deReffer that
  //if the object has a type of "object" then we need to deReffer that

  if (object === undefined) {
    object = spec;
  }

  Object.entries(object).forEach(([key, value]) => {
    if (key === "$ref") {
      const path = (value as string).replace("#", "");
      const ptr = pointer.get(spec, path);
      if (ptr === undefined) {
        throw new Error(`Invalid reference: ${value}`);
      }
      object = {
        ...object,
        ...ptr,
      };
      delete object?.$ref;
    }

    recursive(object, "properties");
    recursive(object, "additionalproperties");
    recursive(object, "allOf");
    recursive(object, "oneOf");
    recursive(object, "anyOf");

    if (object?.items) {
      object.items.forEach((item: any) => {
        deReffer(spec, item);
      });
    }

    function recursive(object: any, key: string) {
      if (object[key] && typeof object[key] === "object") {
        Object.entries(object[key]).forEach(([key, value]) => {
          deReffer(spec, value);
        });
      }
    }
  });
}

import { JSONSchemaInstanceType } from "./types";

export function transformNullables(spec: Record<string, any>) {
  //walk through the object. If there is a key called "nullable" that is set to true then do one of the following
  //1. if their is a sibling key on "type" then turn the type into an array and add "null" to it
  //2. if there is no sibling key on "type" and there's an anyOf, oneOf or allOf then add a null type to each of those
  //3. if there is no sibling key on "type" and there's no anyOf, oneOf or allOf then add an anyOf with null

  Object.entries(spec).forEach(([key, value]) => {
    if (key === "nullable" && value === true) {
      if (!spec.type) {
        if (spec.anyOf || spec.oneOf || spec.allOf) {
          //if there is an anyOf, oneOf or allOf then add a null type to each of those
          if (spec.anyOf) {
            spec.anyOf = [...spec.anyOf, { type: "null" }];
          }
          if (spec.oneOf) {
            spec.oneOf = [...spec.oneOf, { type: "null" }];
          }
          if (spec.allOf) {
            spec.allOf = [...spec.allOf, { type: "null" }];
          }
        } else {
          //if there's not anyOf, oneOf or allOf then we need to create an anyOf with null
          spec.anyOf = [
            {
              type: "null",
            },
            spec,
          ];
        }
        delete spec.nullable;
        return;
      }

      //if there is a type then we can add the "null" type to it
      let combinedTypes: JSONSchemaInstanceType[] = [];
      switch (typeof spec.type) {
        case "string":
          combinedTypes = [spec.type as JSONSchemaInstanceType, "null"];
          break;
        case "object":
          combinedTypes = [...spec.type, "null"];
          break;
        default:
          throw new Error(`Invalid schema type: ${typeof spec.type}`);
      }

      spec.type = combinedTypes;
      delete spec.nullable;

      //enums
      if (spec.enum) {
        spec.enum = [...spec.enum, null];
      }

      return;
    }

    if (typeof value === "object") {
      transformNullables(value);
    }
  });
}

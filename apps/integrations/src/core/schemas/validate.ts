import { JSONSchema, JSONSchemaError } from "./types";
import nodeObjectHash from "node-object-hash";
import Ajv from "ajv";

const ajv = new Ajv({
  strict: false,
  logger: false,
});

type SuccessResult = {
  success: true;
};

type FailureResult = {
  success: false;
  errors: JSONSchemaError[];
};

export async function validate(
  data: any,
  schema?: JSONSchema
): Promise<SuccessResult | FailureResult> {
  try {
    if (schema === undefined) {
      return {
        success: true as const,
      };
    }

    if (data === undefined) {
      return {
        success: false as const,
        errors: [
          {
            keyword: "undefined",
            instancePath: "undefined",
            schemaPath: "undefined",
            params: {},
          },
        ],
      };
    }

    const validator = getValidator(schema);

    const result = validator(data);
    if (!result) {
      return {
        success: false as const,
        errors: validator.errors ?? [],
      };
    }

    return {
      success: true as const,
    };
  } catch (e: any) {
    console.error(e);
    return {
      success: false as const,
      errors: [
        {
          keyword: "undefined",
          instancePath: "undefined",
          schemaPath: "undefined",
          params: {},
          message: e.toString(),
        },
      ],
    };
  }
}

//we are going to has the schemas and use that as the key to find the cached validator
const hasher = nodeObjectHash({ sort: false });

function getValidator(schema: JSONSchema) {
  const hash = hasher.hash(schema);

  // get the validator from the cache, if it doesn't exist, add it to the cache
  let validator = ajv.getSchema(hash);
  if (validator === undefined) {
    ajv.addSchema(schema, hash);
    validator = ajv.getSchema(hash);
  }

  if (validator === undefined) {
    throw new Error("Could not get validator");
  }

  return validator;
}

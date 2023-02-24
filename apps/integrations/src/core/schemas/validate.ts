import { JSONSchema, JSONSchemaError } from "./types";
import nodeObjectHash from "node-object-hash";
import Ajv from "ajv";
import { performance, PerformanceObserver } from "perf_hooks";

//setup performance tracking
const perfObserver = new PerformanceObserver((items) => {
  return;
});
perfObserver.observe({ entryTypes: ["measure"], buffered: true });

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

    performance.mark("get-validator-start");
    const validator = getValidator(schema);
    performance.mark("get-validator-end");

    performance.mark("validate-start");
    const result = validator(data);
    performance.mark("validate-end");

    const getValidatorPerformance = performance.measure(
      "get-validator",
      "get-validator-start",
      "get-validator-end"
    );
    const validatePerformance = performance.measure(
      "validate",
      "validate-start",
      "validate-end"
    );

    if (process.env.SHOW_PERFORMANCE_TESTS === "true") {
      console.log("validate benchmarks:", {
        getValidator: getValidatorPerformance.duration,
        validate: validatePerformance.duration,
      });
    }

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

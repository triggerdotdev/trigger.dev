import { JSONSchema } from "./types";

type SuccessResult = {
  success: true;
};

type FailureResult = {
  success: false;
  errors: {
    keyword: string;
    keywordLocation: string;
    instanceLocation: string;
    error: any;
  }[];
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
            keywordLocation: "undefined",
            instanceLocation: "undefined",
            error: "data is undefined",
          },
        ],
      };
    }

    const Validator = await getValidator();
    const validator = new Validator(schema);
    const result = validator.validate(data);
    if (!result.valid) {
      return {
        success: false as const,
        errors: result.errors,
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
          keywordLocation: "undefined",
          instanceLocation: "undefined",
          error: e.toString(),
        },
      ],
    };
  }
}

async function getValidator() {
  const tool = await import("@cfworker/json-schema");
  return tool.Validator;
}

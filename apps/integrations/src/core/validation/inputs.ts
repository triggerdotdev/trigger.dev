import { InputSpec } from "core/action/types";
import { checkRequiredScopes } from "core/authentication/credentials";
import { RequestError } from "core/request/errors";
import { RequestData, RequestSpec } from "core/request/types";
import { validate } from "core/schemas/validate";

type ValidationResult =
  | {
      success: true;
    }
  | {
      success: false;
      error: RequestError;
    };

export async function validateInputs(
  inputSpec: InputSpec,
  { parameters, body, credentials }: RequestData
): Promise<ValidationResult> {
  if (inputSpec.security) {
    if (credentials === undefined) {
      return {
        success: false,
        error: {
          type: "missing_credentials",
        },
      };
    }
    const requiredScopes = inputSpec.security[credentials.name] ?? [];
    const result = checkRequiredScopes(requiredScopes, credentials);

    if (!result.success) {
      return {
        success: false,
        error: {
          type: "insufficient_scopes",
          missingScopes: result.missingScopes,
        },
      };
    }
  }

  // validate the request body exists if it should
  if (body == null && inputSpec.body != null) {
    return {
      success: false,
      error: {
        type: "missing_body",
      },
    };
  }

  //validate the parameters
  if (inputSpec.parameters != null) {
    for (const parameter of inputSpec.parameters) {
      const { name, required } = parameter;

      // if the parameter is missing
      if (parameters === undefined || parameters[name] == null) {
        if (required) {
          return {
            success: false,
            error: {
              type: "missing_parameter",
              parameter: {
                name,
              },
            },
          };
        } else {
          continue;
        }
      }

      const element = parameters[name];
      //validate the parameter against the schema
      const valid = await validate(element, parameter.schema);
      if (!valid.success) {
        return {
          success: false,
          error: {
            type: "parameter_invalid",
            parameter: {
              name,
              value: element,
            },
            errors: valid.errors,
          },
        };
      }
    }
  }

  return {
    success: true,
  };
}

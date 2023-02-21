import { applyCredentials } from "core/authentication/credentials";
import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import { JSONSchemaError } from "core/schemas/types";
import { validate } from "core/schemas/validate";
import { type Response } from "node-fetch";
import {
  FetchConfig,
  RequestData,
  RequestResponse,
  RequestSpec,
} from "./types";

export async function requestEndpoint(
  { baseUrl, endpointSpec, authentication }: RequestSpec,
  { parameters, body, credentials }: RequestData
): Promise<RequestResponse> {
  const { method, security, request, responses } = endpointSpec;
  let path = endpointSpec.path;

  // validate the request body
  if (body == null && request.body?.schema != null) {
    throw {
      type: "missing_body",
    };
  }

  const requestValid = await validate(body, request.body?.schema);
  if (!requestValid.success) {
    throw {
      type: "request_body_invalid",
      errors: requestValid.errors,
    };
  }

  let headers: Record<string, string> = {};

  // validate and add the parameters
  if (endpointSpec.parameters != null) {
    for (const parameter of endpointSpec.parameters) {
      const { name, in: location, required } = parameter;

      // if the parameter is missing
      if (parameters === undefined || parameters[name] == null) {
        if (required) {
          throw {
            type: "missing_parameter",
            parameter: {
              name,
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
        throw {
          type: "parameter_invalid",
          parameter: {
            name,
            value: element,
          },
          errors: valid.errors,
        };
      }

      //add the parameter
      switch (location) {
        case "path":
          path = path.replace(`{${name}}`, element as string);
          break;
        case "query": {
          if (parameter.schema?.type === "array") {
            const array = element as Array<string>;
            for (const item of array) {
              path = `${path}${path.includes("?") ? "&" : "?"}${name}=${item}`;
            }
            break;
          }

          path = `${path}${path.includes("?") ? "&" : "?"}${name}=${element}`;
          break;
        }
        case "header":
          headers = {
            ...headers,
            [name]: `${element}`,
          };
          break;
      }
    }
  }

  // add headers from the config
  for (const name in request.headers) {
    if (Object.prototype.hasOwnProperty.call(request.headers, name)) {
      const element = request.headers[name];
      headers = {
        ...headers,
        [name]: element,
      };
    }
  }

  // build the fetch config
  const url = `${baseUrl}${path}`;
  let fetchConfig: FetchConfig = {
    url,
    method,
    headers: {
      ...headers,
    },
    body: JSON.stringify(body),
  };

  // apply credentials
  if (security != null) {
    if (credentials == null) {
      throw {
        type: "missing_credentials",
      };
    }
    fetchConfig = applyCredentials(fetchConfig, {
      endpointSecurity: security,
      authentication,
      credentials,
    });
  }

  // do the fetch and try get the JSON
  const fetchObject = {
    method: fetchConfig.method,
    headers: fetchConfig.headers,
    body: fetchConfig.body,
  };

  const fetch = await getFetch();
  const response = await fetch(fetchConfig.url, fetchObject);
  const json = await safeGetJson(response);

  // validate the response against the specs
  const responseSpecs = getResponseSpecsForStatusCode(
    response.status,
    responses
  );
  if (!responseSpecs) {
    throw {
      type: "no_response_spec",
      status: response.status,
    };
  }

  // start with the first spec and loop through them, if one succeeds then return that
  const specErrors: Array<{ name: string; errors: JSONSchemaError[] }> = [];
  for (const spec of responseSpecs) {
    const responseValid = await validate(json, spec.schema);
    if (responseValid.success) {
      return {
        success: spec.success,
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: json,
      };
    } else {
      if (responseValid.errors != null) {
        specErrors.push({ name: spec.name, errors: responseValid.errors });
      }
    }
  }

  throw {
    type: "response_invalid",
    status: response.status,
    body: json,
    errors: specErrors,
  };
}

export async function getFetch() {
  return (await import("node-fetch")).default;
}

export async function safeGetJson(response: Response) {
  try {
    return await response.json();
  } catch (error) {
    return undefined;
  }
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};

  headers.forEach((value, key) => {
    normalizedHeaders[key.toLowerCase()] = value;
  });

  return normalizedHeaders;
}

/** Get the appropriate endpoint response object based on the status code. It supports wild cards like 20x and 2xx */
function getResponseSpecsForStatusCode(
  statusCode: number,
  endpointResponseSpecs: EndpointSpec["responses"]
): EndpointSpecResponse[] {
  let specs = endpointResponseSpecs[statusCode.toString()];
  if (specs) return specs;

  specs =
    endpointResponseSpecs[
      `${statusCode.toString().charAt(0)}${statusCode.toString().charAt(1)}x`
    ];
  if (specs) return specs;

  specs = endpointResponseSpecs[`${statusCode.toString().charAt(0)}xx`];
  if (specs) return specs;

  return endpointResponseSpecs.default;
}

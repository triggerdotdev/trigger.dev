import { applyCredentials } from "core/authentication/credentials";
import {
  getFetch,
  normalizeHeaders,
  responseFromCaughtError,
  safeGetJson,
} from "core/fetch/fetchUtilities";
import { JSONSchemaError } from "core/schemas/types";
import {
  HTTPRequest,
  RequestData,
  RequestResponse,
  RequestSpec,
} from "./types";
import * as Sentry from "@sentry/node";
import JsonPointer from "json-pointer";

export async function requestEndpoint(
  { baseUrl, endpointSpec, authentication }: RequestSpec,
  { parameters, body, credentials }: RequestData
): Promise<RequestResponse> {
  const { method, security, request, responses } = endpointSpec;
  let path = endpointSpec.path;

  // check the request body is there if it's meant to be
  const requiresBody = request.body?.schema != null;
  if (body == null && requiresBody && request.body?.static === undefined) {
    throw {
      type: "missing_body",
    };
  }

  let headers: Record<string, string> = {};

  //if the body doesn't exist but is required, create it
  if (requiresBody && body == null) {
    body = {};
  }

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
        case "body": {
          JsonPointer.set(body, parameter.pointer, element);
          break;
        }
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

  // add any static body content
  if (request.body?.static != null) {
    for (const pointer in request.body.static) {
      if (Object.prototype.hasOwnProperty.call(request.body.static, pointer)) {
        const element = request.body.static[pointer];
        JsonPointer.set(body, pointer, element);
      }
    }
  }

  // build the fetch config
  const url = `${baseUrl}${path}`;
  let fetchConfig: HTTPRequest = {
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

  try {
    const fetch = await getFetch();
    const response = await fetch(fetchConfig.url, fetchObject);
    const json = await safeGetJson(response);

    const normalizedHeaders = normalizeHeaders(response.headers);

    // start with the first response spec and loop through them, if one succeeds then return that
    const specErrors: Array<{ name: string; errors: JSONSchemaError[] }> = [];
    for (const spec of responses) {
      const isMatch = spec.matches({
        statusCode: response.status,
        headers: normalizedHeaders,
        body: json,
      });

      if (!isMatch) {
        continue;
      }

      return {
        success: spec.success,
        status: response.status,
        headers: normalizedHeaders,
        body: json,
      };
    }

    if (process.env.NODE_ENV === "production") {
      //if it's a 2xx response, even if it fails validation we'll return it as a success
      if (response.status >= 200 && response.status < 300) {
        //we want to report this to Sentry though so we can improve the schemas
        Sentry.captureException({
          type: "response_invalid",
          baseUrl: baseUrl,
          spec: endpointSpec,
          status: response.status,
          body: json,
          errors: specErrors,
        });

        return {
          success: true,
          status: response.status,
          headers: normalizeHeaders(response.headers),
          body: json,
        };
      }
    }

    throw {
      type: "no_response_spec",
      status: response.status,
      body: json,
    };
  } catch (error: any) {
    return responseFromCaughtError(error);
  }
}

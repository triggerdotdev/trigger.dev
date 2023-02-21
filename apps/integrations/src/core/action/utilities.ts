import { Endpoint } from "core/endpoint/types";
import { InputSpec, OutputSpec } from "./types";

export function makeInputSpec(endpoint: Endpoint): InputSpec {
  return {
    security: endpoint.spec.endpointSpec.security,
    parameters: endpoint.spec.endpointSpec.parameters,
    body: endpoint.spec.endpointSpec.request.body?.schema,
  };
}

export function makeOutputSpec(endpoint: Endpoint): OutputSpec {
  return {
    responses: endpoint.spec.endpointSpec.responses,
  };
}

export function combineSecurityScopes(
  securities: (Record<string, string[]> | undefined)[]
): Record<string, string[]> | undefined {
  const securityA = securities[0];
  const securityB = securities[1];

  //where a key already exists, concatenate the scope arrays together
  //where a key does not exist, add it to the object
  let combined: Record<string, string[]> = {};

  if (securityA) {
    combined = {
      ...securityA,
    };
  }

  if (securityB) {
    for (const key in securityB) {
      if (combined[key]) {
        combined[key] = [...combined[key], ...securityB[key]];
      } else {
        combined[key] = securityB[key];
      }
    }
  }

  if (securities.length > 2) {
    return combineSecurityScopes([combined, ...securities.slice(2)]);
  }

  return combined;
}

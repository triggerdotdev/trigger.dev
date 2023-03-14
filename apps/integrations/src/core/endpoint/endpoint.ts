import { IntegrationAuthentication } from "core/authentication/types";
import { requestEndpoint } from "core/request/requestEndpoint";
import { RequestData, RequestSpec } from "core/request/types";
import { Endpoint, EndpointSpec } from "./types";

export const makeEndpoint = (spec: RequestSpec) => {
  const request = async (data: RequestData) => {
    return await requestEndpoint(spec, data);
  };

  return {
    spec,
    request,
  };
};

export const makeEndpoints = <
  TSpecs extends Record<string, EndpointSpec>,
  K extends keyof TSpecs
>(
  baseUrl: string,
  authentication: IntegrationAuthentication,
  specs: TSpecs
): Record<K, Endpoint> => {
  const endpoints: any = {};

  Object.entries(specs).forEach(([name, spec]) => {
    endpoints[name as K] = makeEndpoint({
      baseUrl,
      endpointSpec: spec,
      authentication,
    });
  });

  return endpoints;
};

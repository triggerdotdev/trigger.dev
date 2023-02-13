import { CacheService } from "core/cache/types";
import { Endpoint } from "core/endpoint/types";
import { RequestData } from "core/request/types";
import { Metadata } from "./types";
import { makeInputSpec, makeOutputSpec } from "./utilities";

export const makeRequestAction = (endpoint: Endpoint) => {
  const action = async (
    data: RequestData,
    cache?: CacheService,
    metadata?: Metadata
  ) => {
    //a simple request doesn't use the cache or metadata
    return await endpoint.request(data);
  };

  return {
    name: endpoint.spec.endpointSpec.metadata.name,
    description: endpoint.spec.endpointSpec.metadata.description,
    path: endpoint.spec.endpointSpec.path,
    method: endpoint.spec.endpointSpec.method,
    spec: {
      input: makeInputSpec(endpoint),
      output: makeOutputSpec(endpoint),
    },
    action,
  };
};

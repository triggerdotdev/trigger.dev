import { CacheService } from "core/cache/types";
import { Endpoint } from "core/endpoint/types";
import { RequestData, RequestResponse } from "core/request/types";
import { getDisplayProperties } from "./getDisplayProperties";
import { Action, Metadata } from "./types";
import { makeInputSpec, makeOutputSpec } from "./utilities";

/** Create an action where you specify the spec and action */
export const makeAdvancedAction = ({
  endpoint,
  spec,
  action,
}: {
  endpoint: Endpoint;
  spec: Action["spec"];
  action: (
    data: RequestData,
    cache?: CacheService,
    metadata?: Metadata
  ) => Promise<RequestResponse>;
}) => {
  const displayProperties = async (data: RequestData) => {
    return getDisplayProperties(
      data,
      endpoint.spec.endpointSpec.metadata.displayProperties
    );
  };

  return {
    name: endpoint.spec.endpointSpec.metadata.name,
    description: endpoint.spec.endpointSpec.metadata.description,
    path: endpoint.spec.endpointSpec.path,
    method: endpoint.spec.endpointSpec.method,
    spec,
    action,
    displayProperties,
  };
};

/** Creates an action where the spec and data is manipulated */
export const makeSimpleAction = (
  endpoint: Endpoint,
  processSpec?: (specs: Action["spec"]) => Action["spec"],
  preRequest?: (data: RequestData) => RequestData
) => {
  let specs = {
    input: makeInputSpec(endpoint),
    output: makeOutputSpec(endpoint),
  };

  if (processSpec) {
    specs = processSpec(specs);
  }

  const action = async (
    data: RequestData,
    cache?: CacheService,
    metadata?: Metadata
  ) => {
    if (preRequest) {
      data = preRequest(data);
    }
    //a simple request doesn't use the cache or metadata
    return await endpoint.request(data);
  };

  return makeAdvancedAction({
    endpoint,
    spec: specs,
    action,
  });
};

export const makeSimpleActions = <
  TEndpoints extends Record<string, Endpoint>,
  K extends keyof TEndpoints
>(
  endpoints: TEndpoints,
  processSpec?: (specs: Action["spec"]) => Action["spec"],
  preRequest?: (data: RequestData) => RequestData
): Record<K, Action> => {
  const actions: any = {};

  Object.entries(endpoints).forEach(([name, endpoint]) => {
    actions[name as K] = makeSimpleAction(endpoint, processSpec, preRequest);
  });

  return actions;
};

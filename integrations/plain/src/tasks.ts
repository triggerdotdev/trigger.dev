import type { AuthenticatedTask } from "@trigger.dev/sdk";
import {
  GetCustomerByIdParams,
  GetCustomerByIdResponse,
  PlainSDK,
  RemoveTypename,
  UpsertCustomTimelineEntryParams,
  UpsertCustomTimelineEntryResponse,
  UpsertCustomerParams,
  UpsertCustomerResponse,
} from "./types";
import {
  PlainSDKError,
  UpsertCustomTimelineEntryInput,
} from "@team-plain/typescript-sdk";
import { Prettify } from "@trigger.dev/integration-kit/prettify";

function isPlainError(error: unknown): error is PlainSDKError {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string" &&
    "requestId" in error &&
    typeof error.requestId === "string"
  );
}

const getCustomerById: AuthenticatedTask<
  PlainSDK,
  GetCustomerByIdParams,
  GetCustomerByIdResponse
> = {
  run: async (params, client) => {
    const response = await client.getCustomerById(params);

    if (response.error) {
      throw response.error;
    } else {
      return response.data
        ? recursivelyRemoveTypenameProperties(response.data)
        : undefined;
    }
  },
  init: (params) => {
    return {
      name: "Get Customer By Id",
      params,
      icon: "plain",
      properties: [
        {
          label: "Customer ID",
          text: params.customerId,
        },
      ],
    };
  },
};

const upsertCustomer: AuthenticatedTask<
  PlainSDK,
  UpsertCustomerParams,
  UpsertCustomerResponse
> = {
  run: async (params, client) => {
    const response = await client.upsertCustomer(params);

    if (response.error) {
      throw response.error;
    } else {
      return recursivelyRemoveTypenameProperties(response.data);
    }
  },
  init: (params) => {
    return {
      name: "Upsert Customer",
      params,
      icon: "plain",
      properties: [
        ...(params.identifier.customerId
          ? [{ label: "Customer ID", text: params.identifier.customerId }]
          : []),
        ...(params.identifier.emailAddress
          ? [{ label: "Email", text: params.identifier.emailAddress }]
          : []),
        ...(params.identifier.externalId
          ? [{ label: "External ID", text: params.identifier.externalId }]
          : []),
      ],
    };
  },
};

const upsertCustomTimelineEntry: AuthenticatedTask<
  PlainSDK,
  UpsertCustomTimelineEntryParams,
  UpsertCustomTimelineEntryResponse
> = {
  run: async (params, client) => {
    const response = await client.upsertCustomTimelineEntry(params);

    if (response.error) {
      throw response.error;
    } else {
      return recursivelyRemoveTypenameProperties(response.data);
    }
  },
  init: (params) => {
    return {
      name: "Upsert Customer Timeline Entry",
      params,
      icon: "plain",
      properties: [
        { label: "Customer ID", text: params.customerId },
        { label: "Title", text: params.title },
        {
          label: "Components count",
          text: params.components.length.toString(),
        },
      ],
    };
  },
};

// This function removes all the __typename properties from an object, recursively
function recursivelyRemoveTypenameProperties<T extends object>(
  obj: T
): Prettify<RemoveTypename<T>> {
  return JSON.parse(JSON.stringify(obj), (key, value) => {
    if (key === "__typename") {
      return undefined;
    }
    return value;
  });
}

export const tasks = {
  getCustomerById,
  upsertCustomer,
  upsertCustomTimelineEntry,
};

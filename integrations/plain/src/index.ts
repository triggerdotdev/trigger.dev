import { PlainClient, PlainSDKError } from "@team-plain/typescript-sdk";
import {
  IOTask,
  IntegrationTaskKey,
  Json,
  Prettify,
  RunTaskErrorCallback,
  RunTaskOptions,
  retry,
  type ConnectionAuth,
  type IO,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import {
  GetCustomerByIdParams,
  GetCustomerByIdResponse,
  RemoveTypename,
  UpsertCustomTimelineEntryParams,
  UpsertCustomTimelineEntryResponse,
  UpsertCustomerParams,
  UpsertCustomerResponse,
} from "./types";

export type PlainIntegrationOptions = {
  id: string;
  apiKey?: string;
  apiUrl?: string;
};

export class Plain implements TriggerIntegration {
  // @internal
  private _options: PlainIntegrationOptions;
  // @internal
  private _client?: PlainClient;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

  constructor(private options: PlainIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return "LOCAL" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const apiKey = this._options.apiKey ?? auth?.accessToken;

    if (!apiKey) {
      throw new Error(
        `Can't initialize Plain integration (${this._options.id}) as apiKey was undefined`
      );
    }

    const plain = new Plain(this._options);
    plain._io = io;
    plain._connectionKey = connectionKey;
    plain._client = new PlainClient({
      apiKey,
      apiUrl: this._options.apiUrl,
    });
    return plain;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "plain", name: "Plain.com" };
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: PlainClient, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "plain",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  getCustomerById(
    key: IntegrationTaskKey,
    params: GetCustomerByIdParams
  ): Promise<GetCustomerByIdResponse> {
    return this.runTask(
      key,
      async (client) => {
        const response = await client.getCustomerById(params);

        if (response.error) {
          throw response.error;
        } else {
          return response.data ? recursivelyRemoveTypenameProperties(response.data) : undefined;
        }
      },
      {
        name: "Get Customer By Id",
        params,
        icon: "plain",
        properties: [
          {
            label: "Customer ID",
            text: params.customerId,
          },
        ],
      }
    );
  }

  upsertCustomer(
    key: IntegrationTaskKey,
    params: UpsertCustomerParams
  ): Promise<UpsertCustomerResponse> {
    return this.runTask(
      key,
      async (client) => {
        const response = await client.upsertCustomer(params);

        if (response.error) {
          throw response.error;
        } else {
          return recursivelyRemoveTypenameProperties(response.data);
        }
      },
      {
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
      }
    );
  }

  upsertCustomTimelineEntry(
    key: IntegrationTaskKey,
    params: UpsertCustomTimelineEntryParams
  ): Promise<UpsertCustomTimelineEntryResponse> {
    return this.runTask(
      key,
      async (client) => {
        const response = await client.upsertCustomTimelineEntry(params);

        if (response.error) {
          throw response.error;
        } else {
          return recursivelyRemoveTypenameProperties(response.data);
        }
      },
      {
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
      }
    );
  }
}

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

export {
  ComponentBadgeColor,
  ComponentDividerSpacingSize,
  ComponentPlainTextColor,
  ComponentPlainTextSize,
  ComponentSpacerSize,
  ComponentTextColor,
  ComponentTextSize,
} from "@team-plain/typescript-sdk";

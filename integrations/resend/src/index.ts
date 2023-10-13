import {
  retry,
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type Json,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import { Resend as ResendClient } from "resend";

type ResendType = InstanceType<typeof ResendClient>;
type SendEmailData = Parameters<ResendType["sendEmail"]>[0];
type SendEmailResponse = Awaited<ReturnType<ResendType["sendEmail"]>>;

type ErrorResponse = {
  statusCode: number;
  name: string;
  message: string;
};

function isRequestError(error: unknown): error is ErrorResponse {
  return typeof error === "object" && error !== null && "statusCode" in error;
}

// See https://resend.com/docs/api-reference/errors
const skipRetryingErrors = [422, 401, 403, 404, 405, 422];

function onError(error: unknown) {
  if (!isRequestError(error)) {
    if (error instanceof Error) {
      return error;
    }

    return new Error("Unknown error");
  }

  if (skipRetryingErrors.includes(error.statusCode)) {
    return {
      skipRetrying: true,
    };
  }

  return new Error(error.message);
}

export type ResendIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export class Resend implements TriggerIntegration {
  /**
   * @internal
   */
  private _options: ResendIntegrationOptions;
  /**
   * @internal
   */
  private _client?: ResendClient;
  /**
   * @internal
   */
  private _io?: IO;

  // @internal
  private _connectionKey?: string;

  constructor(options: ResendIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const apiKey = this._options.apiKey ?? auth?.accessToken;

    if (!apiKey) {
      throw new Error(
        `Can't create Resend integration (${this._options.id}) as apiKey was undefined`
      );
    }

    const resend = new Resend(this._options);
    resend._io = io;
    resend._connectionKey = connectionKey;
    resend._client = new ResendClient(apiKey);
    return resend;
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: "resend", name: "Resend.com" };
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: ResendClient, task: IOTask, io: IO) => Promise<TResult>,
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
      { icon: "resend", ...(options ?? {}), connectionKey: this._connectionKey },
      errorCallback
    );
  }

  sendEmail(key: IntegrationTaskKey, params: SendEmailData): Promise<SendEmailResponse> {
    return this.runTask(
      key,
      async (client) => {
        const response = await client.sendEmail(params);
        if ("statusCode" in response) {
          throw response;
        }
        return response;
      },
      {
        name: "Send Email",
        params,
        properties: [
          {
            label: "From",
            text: params.from,
          },
          {
            label: "To",
            text: Array.isArray(params.to) ? params.to.join(", ") : params.to,
          },
          ...(params.subject ? [{ label: "Subject", text: params.subject }] : []),
        ],
        retry: retry.standardBackoff,
      },
      onError
    );
  }
}

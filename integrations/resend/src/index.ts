import type {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
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

function onError(error: unknown) {
  if (!isRequestError(error)) {
    if (error instanceof Error) {
      return error;
    }

    return new Error("Unknown error");
  }

  return new Error(error.message);
}

export type ResendIntegrationOptions = {
  id: string;
  apiKey: string;
};

export class Resend implements TriggerIntegration {
  private _options: ResendIntegrationOptions;
  private _client?: ResendClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: ResendIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Resend integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const resend = new Resend(this._options);
    resend._io = io;
    resend._connectionKey = connectionKey;
    resend._client = new ResendClient(this._options.apiKey);
    return resend;
  }

  get id() {
    return this.options.id;
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

    return this._io.runTask<TResult>(
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
        retry: {
          limit: 8,
          factor: 1.8,
          minTimeoutInMs: 500,
          maxTimeoutInMs: 30000,
          randomize: true,
        },
      },
      onError
    );
  }
}

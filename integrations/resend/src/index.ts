import type {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  RunTaskErrorCallback,
  RunTaskOptions,
  RunTaskResult,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { Resend as ResendClient } from "resend";

type SendEmailData = Parameters<InstanceType<typeof ResendClient>["sendEmail"]>[0];

type SendEmailResponse = { id: string };

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

  runTask<TResult extends RunTaskResult = void>(
    key: IntegrationTaskKey,
    callback: (client: ResendClient, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ) {
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
        return client.sendEmail(params) as Promise<SendEmailResponse>;
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
      }
    );
  }
}

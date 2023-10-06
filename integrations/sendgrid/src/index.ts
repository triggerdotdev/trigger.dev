import {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import { MailService } from "@sendgrid/mail";

type SendEmailData = Parameters<InstanceType<typeof MailService>["send"]>[0];

export type SendGridIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export class SendGrid implements TriggerIntegration {
  // @internal
  private _options: SendGridIntegrationOptions;
  // @internal
  private _client?: MailService;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

  constructor(private options: SendGridIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const apiKey = this._options.apiKey ?? auth?.accessToken;

    if (!apiKey) {
      throw new Error(
        `Can't initialize SendGrid integration (${this._options.id}) as apiKey was undefined`
      );
    }

    const sendgrid = new SendGrid(this._options);
    sendgrid._io = io;
    sendgrid._connectionKey = connectionKey;
    sendgrid._client = new MailService();
    sendgrid._client.setApiKey(apiKey);
    return sendgrid;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "sendgrid", name: "SendGrid" };
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: MailService, task: IOTask, io: IO) => Promise<TResult>,
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
        icon: "sendgrid",
        ...(options ?? {}),
        connectionKey: this._connectionKey,
        retry: retry.standardBackoff,
      },
      errorCallback
    );
  }

  sendEmail(key: IntegrationTaskKey, params: SendEmailData) {
    const subjectProperty = Array.isArray(params)
      ? []
      : params.subject
      ? [{ label: "Subject", text: params.subject }]
      : [];

    return this.runTask(
      key,
      async (client) => {
        await client.send(params);
        //we intentional don't return anything, as there's nothing useful in the response
      },
      {
        name: "Send Email",
        params,
        icon: "sendgrid",
        properties: [
          {
            label: "From",
            text: Array.isArray(params)
              ? getEmailFromEmailData(params[0].from)
              : getEmailFromEmailData(params.from),
          },
          {
            label: "To",
            text: Array.isArray(params)
              ? getEmailFromEmailData(params[0]?.to)
              : getEmailFromEmailData(params?.to),
          },
          ...subjectProperty,
        ],
      }
    );
  }
}

type EmailData = string | { name?: string; email: string };
type EmailDataArray = EmailData | EmailData[];

function getEmailFromEmailData(emailData: EmailDataArray | undefined): string {
  if (emailData === undefined) {
    return "";
  }
  if (Array.isArray(emailData)) {
    return emailData.map(getEmailFromEmailData).join(", ");
  }

  if (typeof emailData === "string") {
    return emailData;
  }
  return emailData.email;
}

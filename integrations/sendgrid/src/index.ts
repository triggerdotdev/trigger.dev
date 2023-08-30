import {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  RunTaskErrorCallback,
  RunTaskOptions,
  RunTaskResult,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { MailService } from "@sendgrid/mail";

type SendEmailData = Parameters<InstanceType<typeof MailService>["send"]>[0];

export type SendGridIntegrationOptions = {
  id: string;
  apiKey: string;
};

export class SendGrid implements TriggerIntegration {
  private _options: SendGridIntegrationOptions;
  private _client?: MailService;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: SendGridIntegrationOptions) {
    if (!options.apiKey) {
      throw new Error(`Can't create SendGrid integration (${options.id}) as apiKey was undefined`);
    }

    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const sendgrid = new SendGrid(this._options);
    sendgrid._io = io;
    sendgrid._connectionKey = connectionKey;
    sendgrid._client = new MailService();
    sendgrid._client.setApiKey(this._options.apiKey);
    return sendgrid;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "sendgrid", name: "SendGrid" };
  }

  runTask<TResult extends RunTaskResult = void>(
    key: IntegrationTaskKey,
    callback: (client: MailService, task: IOTask, io: IO) => Promise<TResult>,
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
      { icon: "sendgrid", ...(options ?? {}), connectionKey: this._connectionKey },
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
        retry: {
          limit: 8,
          factor: 1.8,
          minTimeoutInMs: 500,
          maxTimeoutInMs: 30000,
          randomize: true,
        },
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

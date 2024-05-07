import {
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
import { Emails, SendEmailResult } from "./emails";
import { Batch } from "./batch";
import { Contacts } from "./contacts";
import { Audiences } from "./audiences";

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

export type ResendRunTask = InstanceType<typeof Resend>["runTask"];

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

  /**
   * Access the Resend Emails API
   * @example
   * ```ts
   * const response = await io.resend.emails.send("📧", {
   *  to: payload.to,
   *  subject: payload.subject,
   *  text: payload.text,
   *  from: "hello@trigger.dev"
   * });
   * ```
   */
  get emails() {
    return new Emails(this.runTask.bind(this));
  }

  /**
   * Access the Resend Batch Emails API
   * @example
   * ```ts
   * const response = await io.resend.batch.send("📧", [{
   *  to: payload.to,
   *  subject: payload.subject,
   *  text: payload.text,
   *  from: "hello@trigger.dev"
   * }]);
   * ```
   */
  get batch() {
    return new Batch(this.runTask.bind(this));
  }

  /**
   * @deprecated Please use resend.emails.send instead
   */
  async sendEmail(...args: Parameters<typeof this.emails.send>): Promise<SendEmailResult> {
    return this.emails.send(...args);
  }

  /**
   * Access the Resend Audiences API
   * @example
   * ```ts
   * const response = await io.resend.audiences.create("📧", {
   *  name: payload.name
   * });
   * ```
   */

  get audiences() {
    return new Audiences(this.runTask.bind(this));
  }

  /**
   * Access the Resend Contacts API
   * @example
   * ```ts
   * const response = await io.resend.contacts.create("📧", {
   *  email: payload.email,
   *  first_name: payload.first_name,
   *  last_name: payload.last_name,
   *  unsubscribed: payload.unsubscribed,
   *  audience_id: payload.audience_id
   * });
   * ```
   */

  get contacts() {
    return new Contacts(this.runTask.bind(this));
  }
}

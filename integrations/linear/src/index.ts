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
import { LinearClient, RatelimitedLinearError } from "@linear/sdk";
import * as events from "./events";
import { TriggerParams, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";

export type LinearIntegrationOptions = {
  id: string;
  token?: string;
};

export type LinearRunTask = InstanceType<typeof Linear>["runTask"];

export class Linear implements TriggerIntegration {
  private _options: LinearIntegrationOptions;
  private _client?: LinearClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: LinearIntegrationOptions) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Linear integration (${options.id}) as token was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.token ? "LOCAL" : "HOSTED";
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: "linear", name: "Linear" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const linear = new Linear(this._options);
    linear._io = io;
    linear._connectionKey = connectionKey;
    linear._client = this.createClient(auth);
    return linear;
  }

  createClient(auth?: ConnectionAuth) {
    if (auth) {
      return new LinearClient({
        accessToken: auth.accessToken,
      });
    }

    if (this._options.token) {
      return new LinearClient({
        apiKey: this._options.token,
      });
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: LinearClient, task: IOTask, io: IO) => Promise<TResult>,
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
      {
        icon: "linear",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback ?? onError
    );
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachment(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onAttachment, params);
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onAttachmentCreated, params);
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onAttachmentRemoved, params);
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onAttachmentUpdated, params);
  }

  onComment(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onComment, params);
  }

  onCommentCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentCreated, params);
  }

  onCommentRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentRemoved, params);
  }

  onCommentUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentUpdated, params);
  }

  onCycle(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCycle, params);
  }

  onCycleCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCycleCreated, params);
  }

  onCycleRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCycleRemoved, params);
  }

  onCycleUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCycleUpdated, params);
  }

  onIssue(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssue, params);
  }

  onIssueCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueCreated, params);
  }

  onIssueRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueRemoved, params);
  }

  onIssueUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueUpdated, params);
  }

  onIssueLabel(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueLabel, params);
  }

  onIssueLabelCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueLabelCreated, params);
  }

  onIssueLabelRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueLabelRemoved, params);
  }

  onIssueLabelUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueLabelUpdated, params);
  }

  onIssueSLA(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueSLA, params);
  }

  onProject(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProject, params);
  }

  onProjectCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectCreated, params);
  }

  onProjectRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectRemoved, params);
  }

  onProjectUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectUpdated, params);
  }

  onProjectUpdate(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectUpdate, params);
  }

  onProjectUpdateCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateCreated, params);
  }

  onProjectUpdateRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateRemoved, params);
  }

  onProjectUpdateUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateUpdated, params);
  }

  onReaction(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onReaction, params);
  }

  onReactionCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onReactionCreated, params);
  }

  onReactionRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onReactionRemoved, params);
  }

  onReactionUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onReactionUpdated, params);
  }

  webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}

export function onError(error: unknown) {
  if (!(error instanceof RatelimitedLinearError)) {
    return;
  }

  const rateLimitRemaining = error.raw?.response?.headers?.get("X-RateLimit-Requests-Remaining");
  const rateLimitReset = error.raw?.response?.headers?.get("X-RateLimit-Requests-Reset");

  if (rateLimitRemaining === "0" && rateLimitReset) {
    const resetDate = new Date(Number(rateLimitReset) * 1000);

    return {
      retryAt: resetDate,
      error,
    };
  }

  const queryComplexity = error.raw?.response?.headers?.get("X-Complexity");
  const complexityRemaining = error.raw?.response?.headers?.get("X-RateLimit-Complexity-Remaining");
  const complexityReset = error.raw?.response?.headers?.get("X-RateLimit-Complexity-Reset");

  if (
    (complexityRemaining === "0" || Number(complexityRemaining) < Number(queryComplexity)) &&
    complexityReset
  ) {
    const resetDate = new Date(Number(complexityReset) * 1000);

    return {
      retryAt: resetDate,
      error,
    };
  }
}

export { events };

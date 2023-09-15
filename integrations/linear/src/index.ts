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
import { LinearClient } from "@linear/sdk";
import * as events from "./events";
import { WebhookActionType, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";

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
      errorCallback
    );
  }

  // TODO: create separate sources to remove resourceTypes

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachment(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachment, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentCreated, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentRemoved, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  /** **WARNING:** Still in alpha - use with caution! */
  onAttachmentUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentUpdated, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  onComment(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onComment, { ...params, resourceTypes: ["Comment"] });
  }

  onCommentCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentCreated, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCommentRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentRemoved, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCommentUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentUpdated, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCycle(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycle, { ...params, resourceTypes: ["Cycle"] });
  }

  onCycleCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleCreated, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onCycleRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleRemoved, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onCycleUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleUpdated, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onIssue(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssue, { ...params, resourceTypes: ["Issue"] });
  }

  onIssueCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueCreated, {
      ...params,
      resourceTypes: ["Issue"],
    });
  }

  onIssueRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueRemoved, {
      ...params,
      resourceTypes: ["Issue"],
    });
  }

  onIssueUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueUpdated, {
      ...params,
      resourceTypes: ["Issue"],
    });
  }

  onIssueLabel(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabel, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onIssueLabelCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelCreated, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onIssueLabelRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelRemoved, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onIssueLabelUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelUpdated, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onProject(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProject, { ...params, resourceTypes: ["Project"] });
  }

  onProjectCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectCreated, {
      ...params,
      resourceTypes: ["Project"],
    });
  }

  onProjectRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectRemoved, {
      ...params,
      resourceTypes: ["Project"],
    });
  }

  onProjectUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdated, {
      ...params,
      resourceTypes: ["Project"],
    });
  }

  onProjectUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdate, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onProjectUpdateCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateCreated, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onProjectUpdateRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateRemoved, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onProjectUpdateUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateUpdated, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onReaction(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReaction, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  onReactionCreated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionCreated, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  onReactionRemoved(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionRemoved, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  onReactionUpdated(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionUpdated, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}

type OnChangeParams = {
  teamId?: string;
  allPublicTeams?: boolean;
  actionTypes?: WebhookActionType[];
};

// TODO
export function onError(error: unknown) {}

export { events };

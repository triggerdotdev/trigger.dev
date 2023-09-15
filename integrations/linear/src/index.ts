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

  onAttachment(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachment, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  onAttachmentCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentCreate, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  onAttachmentRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentRemove, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  onAttachmentUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onAttachmentUpdate, {
      ...params,
      resourceTypes: ["Attachment"],
    });
  }

  onComment(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onComment, { ...params, resourceTypes: ["Comment"] });
  }

  onCommentCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentCreate, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCommentRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentRemove, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCommentUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCommentUpdate, {
      ...params,
      resourceTypes: ["Comment"],
    });
  }

  onCycle(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycle, { ...params, resourceTypes: ["Cycle"] });
  }

  onCycleCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleCreate, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onCycleRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleRemove, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onCycleUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onCycleUpdate, {
      ...params,
      resourceTypes: ["Cycle"],
    });
  }

  onIssue(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssue, { ...params, resourceTypes: ["Issue"] });
  }

  onIssueCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueCreate, {
      ...params,
      resourceTypes: ["Issue"],
    });
  }

  onIssueRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueRemove, {
      ...params,
      resourceTypes: ["Issue"],
    });
  }

  onIssueUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueUpdate, {
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

  onIssueLabelCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelCreate, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onIssueLabelRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelRemove, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onIssueLabelUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onIssueLabelUpdate, {
      ...params,
      resourceTypes: ["IssueLabel"],
    });
  }

  onProject(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProject, { ...params, resourceTypes: ["Project"] });
  }

  onProject_Create(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProject_Create, {
      ...params,
      resourceTypes: ["Project"],
    });
  }

  onProject_Remove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProject_Remove, {
      ...params,
      resourceTypes: ["Project"],
    });
  }

  onProject_Update(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProject_Update, {
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

  onProjectUpdateCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateCreate, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onProjectUpdateRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateRemove, {
      ...params,
      resourceTypes: ["ProjectUpdate"],
    });
  }

  onProjectUpdateUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onProjectUpdateUpdate, {
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

  onReactionCreate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionCreate, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  onReactionRemove(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionRemove, {
      ...params,
      resourceTypes: ["Reaction"],
    });
  }

  onReactionUpdate(params: OnChangeParams = {}) {
    return createTrigger(this.source, events.onReactionUpdate, {
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

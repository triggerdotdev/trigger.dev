import {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  Prettify,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import {
  AttachmentPayload,
  CommentPayload,
  CyclePayload,
  DeletePayload,
  IssueLabelPayload,
  IssuePayload,
  LinearClient,
  ProjectPayload,
  ProjectUpdatePayload,
  RatelimitedLinearError,
  ReactionPayload,
} from "@linear/sdk";
import * as events from "./events";
import { TriggerParams, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";
import {
  AttachmentCreateInput,
  AttachmentUpdateInput,
  CommentCreateInput,
  CommentUpdateInput,
  CycleCreateInput,
  CycleUpdateInput,
  IssueCreateInput,
  IssueLabelCreateInput,
  IssueLabelUpdateInput,
  IssueUpdateInput,
  ProjectCreateInput,
  ProjectUpdateCreateInput,
  ProjectUpdateInput,
  ProjectUpdateUpdateInput,
  ReactionCreateInput,
} from "@linear/sdk/dist/_generated_documents";
import { LinearReturnType, SerializedLinearOutput } from "./types";

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

  createAttachment(
    key: IntegrationTaskKey,
    params: AttachmentCreateInput
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createAttachment(params);
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Create Attachment",
        params,
        properties: [
          { label: "Title", text: params.title },
          { label: "URL", text: params.url },
        ],
      }
    );
  }

  deleteAttachment(key: IntegrationTaskKey, params: { id: string }): Promise<DeletePayload> {
    return this.runTask(key, (client) => client.deleteAttachment(params.id), {
      name: "Delete Attachment",
      params,
      properties: [{ label: "Attachment ID", text: params.id }],
    });
  }

  updateAttachment(
    key: IntegrationTaskKey,
    params: { id: string; input: AttachmentUpdateInput }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateAttachment(params.id, params.input);
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Update Attachment",
        params,
        properties: [{ label: "Attachment ID", text: params.id }],
      }
    );
  }

  createComment(
    key: IntegrationTaskKey,
    params: CommentCreateInput
  ): LinearReturnType<CommentPayload, "comment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createComment(params);
        return serializeLinearOutput(await payload.comment);
      },
      {
        name: "Create Comment",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Body", text: params.body ?? "" },
        ],
      }
    );
  }

  deleteComment(key: IntegrationTaskKey, params: { id: string }): Promise<DeletePayload> {
    return this.runTask(key, (client) => client.deleteComment(params.id), {
      name: "Delete Comment",
      params,
      properties: [{ label: "Comment ID", text: params.id }],
    });
  }

  updateComment(
    key: IntegrationTaskKey,
    params: { id: string; input: CommentUpdateInput }
  ): LinearReturnType<CommentPayload, "comment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateComment(params.id, params.input);
        return serializeLinearOutput(await payload.comment);
      },
      {
        name: "Update Comment",
        params,
        properties: [{ label: "Comment ID", text: params.id }],
      }
    );
  }

  createCycle(
    key: IntegrationTaskKey,
    params: CycleCreateInput
  ): LinearReturnType<CyclePayload, "cycle"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createCycle(params);
        return serializeLinearOutput(await payload.cycle);
      },
      {
        name: "Create Cycle",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Start at", text: params.startsAt.toISOString() },
          { label: "Ends at", text: params.endsAt.toISOString() },
        ],
      }
    );
  }

  // deleteCycle() does not exist

  updateCycle(
    key: IntegrationTaskKey,
    params: { id: string; input: CycleUpdateInput }
  ): LinearReturnType<CyclePayload, "cycle"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateCycle(params.id, params.input);
        return serializeLinearOutput(await payload.cycle);
      },
      {
        name: "Update Cycle",
        params,
        properties: [{ label: "Cycle ID", text: params.id }],
      }
    );
  }

  createIssue(
    key: IntegrationTaskKey,
    params: IssueCreateInput & { title: string }
  ): LinearReturnType<IssuePayload, "issue"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createIssue(params);
        return serializeLinearOutput(await payload.issue);
      },
      {
        name: "Create Issue",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Title", text: params.title },
        ],
      }
    );
  }

  updateIssue(
    key: IntegrationTaskKey,
    params: { id: string; input: IssueUpdateInput }
  ): LinearReturnType<IssuePayload, "issue"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateIssue(params.id, params.input);
        return serializeLinearOutput(await payload.issue);
      },
      {
        name: "Update Issue",
        params,
        properties: [{ label: "Issue ID", text: params.id }],
      }
    );
  }

  deleteIssue(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<IssuePayload, "issue"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.deleteIssue(params.id);
        return serializeLinearOutput(await payload.entity);
      },
      {
        name: "Delete Issue",
        params,
        properties: [{ label: "Issue ID", text: params.id }],
      }
    );
  }

  createIssueLabel(
    key: IntegrationTaskKey,
    params: IssueLabelCreateInput
  ): LinearReturnType<IssueLabelPayload, "issueLabel"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createIssueLabel(params);
        return serializeLinearOutput(await payload.issueLabel);
      },
      {
        name: "Create IssueLabel",
        params,
        properties: [
          { label: "Label name", text: params.name },
        ],
      }
    );
  }

  deleteIssueLabel(key: IntegrationTaskKey, params: { id: string }): Promise<DeletePayload> {
    return this.runTask(key, (client) => client.deleteIssueLabel(params.id), {
      name: "Delete IssueLabel",
      params,
      properties: [{ label: "Label ID", text: params.id }],
    });
  }

  updateIssueLabel(
    key: IntegrationTaskKey,
    params: { id: string; input: IssueLabelUpdateInput }
  ): LinearReturnType<IssueLabelPayload, "issueLabel"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateIssueLabel(params.id, params.input);
        return serializeLinearOutput(await payload.issueLabel);
      },
      {
        name: "Update IssueLabel",
        params,
        properties: [{ label: "Label ID", text: params.id }],
      }
    );
  }

  createProject(
    key: IntegrationTaskKey,
    params: ProjectCreateInput
  ): LinearReturnType<ProjectPayload, "project"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createProject(params);
        return serializeLinearOutput(await payload.project);
      },
      {
        name: "Create Project",
        params,
        properties: [
          { label: "Team IDs", text: params.teamIds.join(", ") },
          { label: "Project name", text: params.name },
        ],
      }
    );
  }

  deleteProject(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<ProjectPayload, "project"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.deleteProject(params.id);
        return serializeLinearOutput(await payload.entity);
      },
      {
        name: "Delete Project",
        params,
        properties: [{ label: "Project ID", text: params.id }],
      }
    );
  }

  updateProject(
    key: IntegrationTaskKey,
    params: { id: string; input: ProjectUpdateInput }
  ): LinearReturnType<ProjectPayload, "project"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateProject(params.id, params.input);
        return serializeLinearOutput(await payload.project);
      },
      {
        name: "Update Project",
        params,
        properties: [{ label: "Project ID", text: params.id }],
      }
    );
  }

  createProjectUpdate(
    key: IntegrationTaskKey,
    params: ProjectUpdateCreateInput
  ): LinearReturnType<ProjectUpdatePayload, "projectUpdate"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createProjectUpdate(params);
        return serializeLinearOutput(await payload.projectUpdate);
      },
      {
        name: "Create ProjectUpdate",
        params,
        properties: [
          { label: "Project ID", text: params.projectId },
        ],
      }
    );
  }

  deleteProjectUpdate(
    key: IntegrationTaskKey,
    params: { id: string }
  ): Promise<DeletePayload> {
    return this.runTask(
      key,
      (client) => client.deleteProjectUpdate(params.id),
      {
        name: "Delete ProjectUpdate",
        params,
        properties: [{ label: "ProjectUpdate ID", text: params.id }],
      }
    );
  }

  updateProjectUpdate(
    key: IntegrationTaskKey,
    params: { id: string; input: ProjectUpdateUpdateInput }
  ): LinearReturnType<ProjectUpdatePayload, "projectUpdate"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateProjectUpdate(params.id, params.input);
        return serializeLinearOutput(await payload.projectUpdate);
      },
      {
        name: "Update ProjectUpdate",
        params,
        properties: [{ label: "ProjectUpdate ID", text: params.id }],
      }
    );
  }

  createReaction(
    key: IntegrationTaskKey,
    params: ReactionCreateInput & { emoji: string }
  ): LinearReturnType<ReactionPayload, "reaction"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createReaction(params);
        return serializeLinearOutput(await payload.reaction);
      },
      {
        name: "Create Reaction",
        params,
        properties: [
          { label: "Comment ID", text: params.commentId ?? "N/A" },
          { label: "Issue ID", text: params.issueId ?? "N/A" },
          { label: "Emoji", text: params.emoji },
        ],
      }
    );
  }

  deleteReaction(key: IntegrationTaskKey, params: { id: string }): Promise<DeletePayload> {
    return this.runTask(key, (client) => client.deleteReaction(params.id), {
      name: "Delete Reaction",
      params,
      properties: [{ label: "Reaction ID", text: params.id }],
    });
  }

  // updateReaction() does not exist

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

  /** Good luck ever triggering this! */
  onReactionUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onReactionUpdated, params);
  }

  webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (error instanceof LinearError) {
    // fail fast on user errors
    if (error.errors?.some((e) => e.userError)) {
      return {
        skipRetrying: true,
      };
    }
  }

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

export const serializeLinearOutput = <T>(obj: T): Prettify<SerializedLinearOutput<T>> => {
  return JSON.parse(JSON.stringify(obj), (key, value) => {
    if (typeof value === "function" || key.startsWith("_")) {
      return undefined;
    }
    return value;
  });
};

export { events };

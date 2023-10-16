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
  Attachment,
  AttachmentConnection,
  AttachmentPayload,
  Comment,
  CommentConnection,
  CommentPayload,
  Connection,
  CreateOrJoinOrganizationResponse,
  CycleArchivePayload,
  CyclePayload,
  DeletePayload,
  Document,
  DocumentConnection,
  DocumentPayload,
  DocumentSearchPayload,
  Favorite,
  FavoriteConnection,
  FavoritePayload,
  FrontAttachmentPayload,
  Issue,
  IssueArchivePayload,
  IssueConnection,
  IssueLabel,
  IssueLabelConnection,
  IssueLabelPayload,
  IssuePayload,
  IssuePriorityValue,
  IssueRelation,
  IssueRelationConnection,
  IssueRelationPayload,
  IssueSearchPayload,
  LinearClient,
  LinearDocument as L,
  LinearError,
  Notification,
  NotificationArchivePayload,
  NotificationConnection,
  NotificationSubscriptionPayload,
  Organization,
  OrganizationInvitePayload,
  Project,
  ProjectArchivePayload,
  ProjectConnection,
  ProjectLink,
  ProjectLinkConnection,
  ProjectLinkPayload,
  ProjectMilestonePayload,
  ProjectPayload,
  ProjectSearchPayload,
  ProjectUpdate,
  ProjectUpdateConnection,
  ProjectUpdatePayload,
  RatelimitedLinearError,
  ReactionPayload,
  RoadmapArchivePayload,
  RoadmapPayload,
  Team,
  TeamConnection,
  TeamMembership,
  TeamMembershipConnection,
  TeamMembershipPayload,
  TeamPayload,
  Template,
  User,
  UserConnection,
  UserPayload,
  WorkflowState,
  WorkflowStateArchivePayload,
  WorkflowStateConnection,
  WorkflowStatePayload,
} from "@linear/sdk";

import * as events from "./events";
import { AwaitNested, LinearReturnType, SerializedLinearOutput } from "./types";
import { Nullable, QueryVariables, queryProperties } from "./utils";
import { TriggerParams, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";

export type LinearIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export type LinearRunTask = InstanceType<typeof Linear>["runTask"];

export class Linear implements TriggerIntegration {
  private _options: LinearIntegrationOptions;
  private _client?: LinearClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: LinearIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Linear integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? "LOCAL" : "HOSTED";
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

    if (this._options.apiKey) {
      return new LinearClient({
        apiKey: this._options.apiKey,
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

    return this._io.runTask(
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

  async getAll<
    TTask extends (
      key: IntegrationTaskKey,
      params: Partial<Nullable<QueryVariables>>
    ) => LinearReturnType<Connection<unknown>>,
  >(
    task: TTask,
    key: IntegrationTaskKey,
    params: Parameters<TTask>[1] = {}
  ): Promise<Awaited<ReturnType<TTask>>["nodes"]> {
    const boundTask = task.bind(this as any);

    let edges = await boundTask(`${key}-0`, params);
    let nodes = edges.nodes;

    for (let i = 1; edges.pageInfo.hasNextPage; i++) {
      edges = await boundTask(`${key}-${i}`, { ...params, after: edges.pageInfo.endCursor });
      nodes = nodes.concat(edges.nodes);
    }

    return nodes;
  }

  attachment(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Attachment> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.attachment(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Attachment",
        params,
        properties: [{ label: "Attachment ID", text: params.id }],
      }
    );
  }

  attachments(
    key: IntegrationTaskKey,
    params: L.AttachmentsQueryVariables = {}
  ): LinearReturnType<AttachmentConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.attachments(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Attachments",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createAttachment(
    key: IntegrationTaskKey,
    params: L.AttachmentCreateInput
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
          { label: "Issue ID", text: params.issueId },
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
    params: { id: string; input: L.AttachmentUpdateInput }
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

  attachmentLinkDiscord(
    key: IntegrationTaskKey,
    params: {
      channelId: string;
      issueId: string;
      messageId: string;
      url: string;
      variables?: Omit<
        L.AttachmentLinkDiscordMutationVariables,
        "channelId" | "issueId" | "messageId" | "url"
      >;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkDiscord(
          params.channelId,
          params.issueId,
          params.messageId,
          params.url,
          params.variables
        );
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link Discord Message",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Channel ID", text: params.channelId },
          { label: "Message ID", text: params.messageId },
          { label: "URL", text: params.url },
        ],
      }
    );
  }

  attachmentLinkFront(
    key: IntegrationTaskKey,
    params: {
      conversationId: string;
      issueId: string;
      variables?: Omit<L.AttachmentLinkFrontMutationVariables, "conversationId" | "issueId">;
    }
  ): LinearReturnType<FrontAttachmentPayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkFront(
          params.conversationId,
          params.issueId,
          params.variables
        );
        return serializeLinearOutput(payload);
      },
      {
        name: "Link Front Conversation",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Conversation ID", text: params.conversationId },
        ],
      }
    );
  }

  attachmentLinkIntercom(
    key: IntegrationTaskKey,
    params: {
      conversationId: string;
      issueId: string;
      variables?: Omit<L.AttachmentLinkIntercomMutationVariables, "conversationId" | "issueId">;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkIntercom(
          params.conversationId,
          params.issueId,
          params.variables
        );
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link Intercom Conversation",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Conversation ID", text: params.conversationId },
        ],
      }
    );
  }

  attachmentLinkJiraIssue(
    key: IntegrationTaskKey,
    params: {
      issueId: string;
      jiraIssueId: string;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkJiraIssue(params.issueId, params.jiraIssueId);
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link Jira Issue",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Jira Issue ID", text: params.jiraIssueId },
        ],
      }
    );
  }

  attachmentLinkSlack(
    key: IntegrationTaskKey,
    params: {
      channel: string;
      issueId: string;
      latest: string;
      url: string;
      variables?: Omit<
        L.AttachmentLinkSlackMutationVariables,
        "channel" | "issueId" | "latest" | "url"
      >;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkSlack(
          params.channel,
          params.issueId,
          params.latest,
          params.url,
          params.variables
        );
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link Slack Message",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Channel", text: params.channel },
          { label: "Latest", text: params.latest },
          { label: "URL", text: params.url },
        ],
      }
    );
  }

  attachmentLinkURL(
    key: IntegrationTaskKey,
    params: {
      issueId: string;
      url: string;
      variables?: Omit<L.AttachmentLinkUrlMutationVariables, "issueId" | "url">;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkURL(
          params.issueId,
          params.url,
          params.variables
        );
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link URL",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "URL", text: params.url },
        ],
      }
    );
  }

  attachmentLinkZendesk(
    key: IntegrationTaskKey,
    params: {
      issueId: string;
      ticketId: string;
      variables?: Omit<L.AttachmentLinkZendeskMutationVariables, "issueId" | "ticketId">;
    }
  ): LinearReturnType<AttachmentPayload, "attachment"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.attachmentLinkZendesk(
          params.issueId,
          params.ticketId,
          params.variables
        );
        return serializeLinearOutput(await payload.attachment);
      },
      {
        name: "Link Zendesk Ticket",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Ticket ID", text: params.ticketId },
        ],
      }
    );
  }

  comment(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Comment> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.comment(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Comment",
        params,
        properties: [{ label: "Comment ID", text: params.id }],
      }
    );
  }

  comments(
    key: IntegrationTaskKey,
    params: L.CommentsQueryVariables = {}
  ): LinearReturnType<CommentConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.comments(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Comments",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createComment(
    key: IntegrationTaskKey,
    params: L.CommentCreateInput
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
    params: { id: string; input: L.CommentUpdateInput }
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

  archiveCycle(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<AwaitNested<CycleArchivePayload, "entity">> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveCycle(params.id);
        return serializeLinearOutput({
          ...payload,
          entity: await payload.entity,
        });
      },
      {
        name: "Archive Cycle",
        params,
        properties: [{ label: "Cycle ID", text: params.id }],
      }
    );
  }

  createCycle(
    key: IntegrationTaskKey,
    params: L.CycleCreateInput
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
    params: { id: string; input: L.CycleUpdateInput }
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

  document(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Document> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.document(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Document",
        params,
        properties: [{ label: "Document ID", text: params.id }],
      }
    );
  }

  documents(
    key: IntegrationTaskKey,
    params: L.DocumentsQueryVariables
  ): LinearReturnType<DocumentConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.documents(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Documents",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createDocument(
    key: IntegrationTaskKey,
    params: L.DocumentCreateInput
  ): LinearReturnType<DocumentPayload, "document"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createDocument(params);
        return serializeLinearOutput(await payload.document);
      },
      {
        name: "Create Document",
        params,
        properties: [
          { label: "Project ID", text: params.projectId },
          { label: "Title", text: params.title },
        ],
      }
    );
  }

  searchDocuments(
    key: IntegrationTaskKey,
    params: {
      term: string;
      variables?:  Parameters<LinearClient["searchDocuments"]>[1];
    }
  ): LinearReturnType<DocumentSearchPayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.searchDocuments(params.term, params.variables);
        return serializeLinearOutput(payload);
      },
      {
        name: "Search Documents",
        params,
        properties: [{ label: "Search Term", text: params.term }],
      }
    );
  }

  favorite(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Favorite> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.favorite(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Favorite",
        params,
        properties: [{ label: "Favorite ID", text: params.id }],
      }
    );
  }

  favorites(
    key: IntegrationTaskKey,
    params: L.FavoritesQueryVariables = {}
  ): LinearReturnType<FavoriteConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.favorites(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Favorites",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createFavorite(
    key: IntegrationTaskKey,
    params: L.FavoriteCreateInput
  ): LinearReturnType<FavoritePayload, "favorite"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createFavorite(params);
        return serializeLinearOutput(await payload.favorite);
      },
      {
        name: "Create Favorite",
        params,
      }
    );
  }

  issue(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Issue> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.issue(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Issue",
        params,
        properties: [{ label: "Issue ID", text: params.id }],
      }
    );
  }

  issues(
    key: IntegrationTaskKey,
    params: L.IssuesQueryVariables = {}
  ): LinearReturnType<IssueConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.issues(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Issues",
        params,
        properties: queryProperties(params),
      }
    );
  }

  archiveIssue(
    key: IntegrationTaskKey,
    params: {
      id: string;
      variables?: Omit<L.ArchiveIssueMutationVariables, "id">;
    }
  ): LinearReturnType<AwaitNested<IssueArchivePayload, "entity">> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveIssue(params.id, params.variables);
        return serializeLinearOutput({
          ...payload,
          entity: await payload.entity,
        });
      },
      {
        name: "Archive Issue",
        params,
        properties: [{ label: "Issue ID", text: params.id }],
      }
    );
  }

  createIssue(
    key: IntegrationTaskKey,
    params: L.IssueCreateInput & { title: string }
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

  searchIssues(
    key: IntegrationTaskKey,
    params: {
      term: string;
      variables?: Parameters<LinearClient["searchIssues"]>[1];
    }
  ): LinearReturnType<IssueSearchPayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.searchIssues(params.term, params.variables);
        return serializeLinearOutput(payload);
      },
      {
        name: "Search Issues",
        params,
        properties: [{ label: "Search Term", text: params.term }],
      }
    );
  }

  updateIssue(
    key: IntegrationTaskKey,
    params: { id: string; input: L.IssueUpdateInput }
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

  issueLabel(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<IssueLabel> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.issueLabel(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get IssueLabel",
        params,
        properties: [{ label: "IssueLabel ID", text: params.id }],
      }
    );
  }

  issueLabels(
    key: IntegrationTaskKey,
    params: L.IssueLabelsQueryVariables = {}
  ): LinearReturnType<IssueLabelConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.issueLabels(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get IssueLabels",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createIssueLabel(
    key: IntegrationTaskKey,
    params: L.IssueLabelCreateInput
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
        properties: [{ label: "Label name", text: params.name }],
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
    params: { id: string; input: L.IssueLabelUpdateInput }
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

  issuePriorityValues(key: IntegrationTaskKey): LinearReturnType<IssuePriorityValue[]> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.issuePriorityValues;
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Issue Priority Values",
      }
    );
  }

  issueRelation(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<IssueRelation> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.issueRelation(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get IssueRelation",
        params,
        properties: [{ label: "IssueRelation ID", text: params.id }],
      }
    );
  }

  issueRelations(
    key: IntegrationTaskKey,
    params: L.IssueRelationsQueryVariables = {}
  ): LinearReturnType<IssueRelationConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.issueRelations(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get IssueRelations",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createIssueRelation(
    key: IntegrationTaskKey,
    params: L.IssueRelationCreateInput
  ): LinearReturnType<IssueRelationPayload, "issueRelation"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createIssueRelation(params);
        return serializeLinearOutput(await payload.issueRelation);
      },
      {
        name: "Create IssueRelation",
        params,
        properties: [
          { label: "Issue ID", text: params.issueId },
          { label: "Related Issue ID", text: params.relatedIssueId },
          { label: "Relation Type", text: params.type },
        ],
      }
    );
  }

  notification(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Notification> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.notification(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Notification",
        params,
        properties: [{ label: "Notification ID", text: params.id }],
      }
    );
  }

  notifications(
    key: IntegrationTaskKey,
    params: L.NotificationsQueryVariables = {}
  ): LinearReturnType<NotificationConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.notifications(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Notifications",
        params,
        properties: queryProperties(params),
      }
    );
  }

  archiveNotification(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<NotificationArchivePayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveNotification(params.id);
        return serializeLinearOutput(payload);
      },
      {
        name: "Archive Notification",
        params,
        properties: [{ label: "Notification ID", text: params.id }],
      }
    );
  }

  createNotificationSubscription(
    key: IntegrationTaskKey,
    params: {
      input: L.NotificationSubscriptionCreateInput;
    }
  ): LinearReturnType<NotificationSubscriptionPayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createNotificationSubscription(params.input);
        return serializeLinearOutput(payload);
      },
      {
        name: "Create Notification Subscription",
        params,
      }
    );
  }

  organization(key: IntegrationTaskKey): LinearReturnType<Organization> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.organization;
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Viewer's Organization",
      }
    );
  }

  createOrganizationFromOnboarding(
    key: IntegrationTaskKey,
    params: {
      input: L.CreateOrganizationInput;
      variables?: Omit<L.CreateOrganizationFromOnboardingMutationVariables, "input">;
    }
  ): LinearReturnType<CreateOrJoinOrganizationResponse, "organization"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createOrganizationFromOnboarding(
          params.input,
          params.variables
        );
        return serializeLinearOutput(await payload.organization);
      },
      {
        name: "Create Organization",
        params,
        properties: [
          { label: "Name", text: params.input.name },
          { label: "URL Key", text: params.input.urlKey },
        ],
      }
    );
  }

  /** WARNING: Causes internal server errors on Linear's side, regardless of input. */
  createOrganizationInvite(
    key: IntegrationTaskKey,
    params: {
      input: L.OrganizationInviteCreateInput;
    }
  ): LinearReturnType<OrganizationInvitePayload, "organizationInvite"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createOrganizationInvite(params.input);
        return serializeLinearOutput(await payload.organizationInvite);
      },
      {
        name: "Create Organization Invite",
        params,
        properties: [{ label: "Invitee Email", text: params.input.email }],
      }
    );
  }

  project(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Project> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.project(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Project",
        params,
        properties: [{ label: "Project ID", text: params.id }],
      }
    );
  }

  projects(
    key: IntegrationTaskKey,
    params: L.ProjectsQueryVariables = {}
  ): LinearReturnType<ProjectConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.projects(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Projects",
        params,
        properties: queryProperties(params),
      }
    );
  }

  archiveProject(
    key: IntegrationTaskKey,
    params: {
      id: string;
      variables?: Omit<L.ArchiveProjectMutationVariables, "id">;
    }
  ): LinearReturnType<AwaitNested<ProjectArchivePayload, "entity">> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveProject(params.id, params.variables);
        return serializeLinearOutput({
          ...payload,
          entity: await payload.entity,
        });
      },
      {
        name: "Archive Project",
        params,
        properties: [{ label: "Project ID", text: params.id }],
      }
    );
  }

  createProject(
    key: IntegrationTaskKey,
    params: L.ProjectCreateInput
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

  searchProjects(
    key: IntegrationTaskKey,
    params: {
      term: string;
      variables?: Parameters<LinearClient["searchProjects"]>[1];
    }
  ): LinearReturnType<ProjectSearchPayload> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.searchProjects(params.term, params.variables);
        return serializeLinearOutput(payload);
      },
      {
        name: "Search Projects",
        params,
        properties: [{ label: "Search Term", text: params.term }],
      }
    );
  }

  updateProject(
    key: IntegrationTaskKey,
    params: { id: string; input: L.ProjectUpdateInput }
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

  projectLink(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<ProjectLink> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.projectLink(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get ProjectLink",
        params,
        properties: [{ label: "ProjectLink ID", text: params.id }],
      }
    );
  }

  projectLinks(
    key: IntegrationTaskKey,
    params: L.ProjectLinksQueryVariables = {}
  ): LinearReturnType<ProjectLinkConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.projectLinks(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get ProjectLinks",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createProjectLink(
    key: IntegrationTaskKey,
    params: L.ProjectLinkCreateInput
  ): LinearReturnType<ProjectLinkPayload, "projectLink"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createProjectLink(params);
        return serializeLinearOutput(await payload.projectLink);
      },
      {
        name: "Create ProjectLink",
        params,
        properties: [
          { label: "Project ID", text: params.projectId },
          { label: "Link Label", text: params.label },
          { label: "Link URL", text: params.url },
        ],
      }
    );
  }

  createProjectMilestone(
    key: IntegrationTaskKey,
    params: L.ProjectMilestoneCreateInput
  ): LinearReturnType<ProjectMilestonePayload, "projectMilestone"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createProjectMilestone(params);
        return serializeLinearOutput(await payload.projectMilestone);
      },
      {
        name: "Create ProjectMilestone",
        params,
        properties: [
          { label: "Project ID", text: params.projectId },
          { label: "Milestone Name", text: params.name },
        ],
      }
    );
  }

  projectUpdate(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<ProjectUpdate> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.projectUpdate(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get ProjectUpdate",
        params,
        properties: [{ label: "ProjectUpdate ID", text: params.id }],
      }
    );
  }

  projectUpdates(
    key: IntegrationTaskKey,
    params: L.ProjectUpdatesQueryVariables = {}
  ): LinearReturnType<ProjectUpdateConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.projectUpdates(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get ProjectUpdates",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createProjectUpdate(
    key: IntegrationTaskKey,
    params: L.ProjectUpdateCreateInput
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
        properties: [{ label: "Project ID", text: params.projectId }],
      }
    );
  }

  deleteProjectUpdate(key: IntegrationTaskKey, params: { id: string }): Promise<DeletePayload> {
    return this.runTask(key, (client) => client.deleteProjectUpdate(params.id), {
      name: "Delete ProjectUpdate",
      params,
      properties: [{ label: "ProjectUpdate ID", text: params.id }],
    });
  }

  updateProjectUpdate(
    key: IntegrationTaskKey,
    params: { id: string; input: L.ProjectUpdateUpdateInput }
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
    params: L.ReactionCreateInput & { emoji: string }
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
          ...(params.commentId ? [{ label: "Comment ID", text: params.commentId }] : []),
          ...(params.issueId ? [{ label: "Issue ID", text: params.issueId }] : []),
          ...(params.projectUpdateId
            ? [{ label: "ProjectUpdate ID", text: params.projectUpdateId }]
            : []),
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

  archiveRoadmap(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<AwaitNested<RoadmapArchivePayload, "entity">> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveRoadmap(params.id);
        return serializeLinearOutput({
          ...payload,
          entity: await payload.entity,
        });
      },
      {
        name: "Archive Roadmap",
        params,
        properties: [{ label: "Roadmap ID", text: params.id }],
      }
    );
  }

  createRoadmap(
    key: IntegrationTaskKey,
    params: L.RoadmapCreateInput
  ): LinearReturnType<RoadmapPayload, "roadmap"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createRoadmap(params);
        return serializeLinearOutput(await payload.roadmap);
      },
      {
        name: "Create Roadmap",
        params,
        properties: [{ label: "Roadmap Name", text: params.name }],
      }
    );
  }

  team(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Team> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.team(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Team",
        params,
        properties: [{ label: "Team ID", text: params.id }],
      }
    );
  }

  teams(
    key: IntegrationTaskKey,
    params: L.TeamsQueryVariables = {}
  ): LinearReturnType<TeamConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.teams(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Teams",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createTeam(
    key: IntegrationTaskKey,
    params: L.TeamCreateInput
  ): LinearReturnType<TeamPayload, "team"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createTeam(params);
        return serializeLinearOutput(await payload.team);
      },
      {
        name: "Create Team",
        params,
        properties: [{ label: "Team Name", text: params.name }],
      }
    );
  }

  teamMembership(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<TeamMembership> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.teamMembership(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get TeamMembership",
        params,
        properties: [{ label: "TeamMembership ID", text: params.id }],
      }
    );
  }

  teamMemberships(
    key: IntegrationTaskKey,
    params: L.TeamMembershipsQueryVariables = {}
  ): LinearReturnType<TeamMembershipConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.teamMemberships(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get TeamMemberships",
        params,
        properties: queryProperties(params),
      }
    );
  }

  createTeamMembership(
    key: IntegrationTaskKey,
    params: L.TeamMembershipCreateInput
  ): LinearReturnType<TeamMembershipPayload, "teamMembership"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createTeamMembership(params);
        return serializeLinearOutput(await payload.teamMembership);
      },
      {
        name: "Create TeamMembership",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "User ID", text: params.userId },
        ],
      }
    );
  }

  template(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Template> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.template(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Template",
        properties: [{ label: "Template ID", text: params.id }],
      }
    );
  }

  templates(key: IntegrationTaskKey): LinearReturnType<Template[]> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.templates;
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Templates",
      }
    );
  }

  user(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<User> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.user(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get User",
        params,
        properties: [{ label: "User ID", text: params.id }],
      }
    );
  }

  users(
    key: IntegrationTaskKey,
    params: L.UsersQueryVariables = {}
  ): LinearReturnType<UserConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.users(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get Users",
        params,
        properties: queryProperties(params),
      }
    );
  }

  updateUser(
    key: IntegrationTaskKey,
    params: { id: string; input: L.UpdateUserInput }
  ): LinearReturnType<UserPayload, "user"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.updateUser(params.id, params.input);
        return serializeLinearOutput(await payload.user);
      },
      {
        name: "Update User",
        params,
        properties: [{ label: "User ID", text: params.id }],
      }
    );
  }

  viewer(key: IntegrationTaskKey): LinearReturnType<User> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.viewer;
        return serializeLinearOutput(entity);
      },
      {
        name: "Get Viewer",
      }
    );
  }

  workflowState(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<WorkflowState> {
    return this.runTask(
      key,
      async (client) => {
        const entity = await client.workflowState(params.id);
        return serializeLinearOutput(entity);
      },
      {
        name: "Get WorkflowState",
        params,
        properties: [{ label: "WorkflowState ID", text: params.id }],
      }
    );
  }

  workflowStates(
    key: IntegrationTaskKey,
    params: L.WorkflowStatesQueryVariables = {}
  ): LinearReturnType<WorkflowStateConnection> {
    return this.runTask(
      key,
      async (client) => {
        const edges = await client.workflowStates(params);
        return serializeLinearOutput(edges);
      },
      {
        name: "Get WorkflowStates",
        params,
        properties: queryProperties(params),
      }
    );
  }

  archiveWorkflowState(
    key: IntegrationTaskKey,
    params: { id: string }
  ): LinearReturnType<AwaitNested<WorkflowStateArchivePayload, "entity">> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.archiveWorkflowState(params.id);
        return serializeLinearOutput({
          ...payload,
          entity: await payload.entity,
        });
      },
      {
        name: "Archive WorkflowState",
        params,
        properties: [{ label: "WorkflowState ID", text: params.id }],
      }
    );
  }

  createWorkflowState(
    key: IntegrationTaskKey,
    params: L.WorkflowStateCreateInput
  ): LinearReturnType<WorkflowStatePayload, "workflowState"> {
    return this.runTask(
      key,
      async (client) => {
        const payload = await client.createWorkflowState(params);
        return serializeLinearOutput(await payload.workflowState);
      },
      {
        name: "Create WorkflowState",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Workflow Type", text: params.type },
          { label: "State Name", text: params.name },
          { label: "State Color", text: params.color },
        ],
      }
    );
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

  onIssueSLASet(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueSLASet, params);
  }

  onIssueSLABreached(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueSLABreached, params);
  }

  onIssueSLAHighRisk(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onIssueSLAHighRisk, params);
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

  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  webhook = this.#webhooks.webhook;
  webhooks = this.#webhooks.webhooks;

  createWebhook = this.#webhooks.createWebhook;
  deleteWebhook = this.#webhooks.deleteWebhook;
  updateWebhook = this.#webhooks.updateWebhook;
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

export const PaginationOrderBy = L.PaginationOrderBy;

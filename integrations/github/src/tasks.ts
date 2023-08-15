import { RequestError } from "@octokit/request-error";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import type { AuthenticatedTask } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { issueProperties, repoProperties } from "./propertyHelpers";

type OctokitClient = InstanceType<typeof Octokit>;

type GithubAuthenticatedTask<
  TParams extends Record<string, unknown>,
  TFunction extends (...args: any[]) => any,
> = AuthenticatedTask<OctokitClient, TParams, GetResponseDataTypeFromEndpointMethod<TFunction>>;

function isRequestError(error: unknown): error is RequestError {
  return typeof error === "object" && error !== null && "status" in error;
}

function onError(error: unknown) {
  if (!isRequestError(error)) {
    return;
  }

  // Check if this is a rate limit error
  if (error.status === 403 && error.response) {
    const rateLimitRemaining = error.response.headers["x-ratelimit-remaining"];
    const rateLimitReset = error.response.headers["x-ratelimit-reset"];

    if (rateLimitRemaining === "0" && rateLimitReset) {
      const resetDate = new Date(Number(rateLimitReset) * 1000);

      return {
        retryAt: resetDate,
        error,
      };
    }
  }
}

const createIssue: GithubAuthenticatedTask<
  { title: string; owner: string; repo: string },
  OctokitClient["rest"]["issues"]["create"]
> = {
  onError,
  run: async (params, client, task, io) => {
    return client.rest.issues
      .create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Title",
          text: params.title,
        },
      ],
      retry: {
        limit: 3,
        factor: 2,
        minTimeoutInMs: 500,
        maxTimeoutInMs: 30000,
        randomize: true,
      },
    };
  },
};

type AddIssueAssigneesTask = GithubAuthenticatedTask<
  { owner: string; repo: string; issueNumber: number; assignees: string[] },
  OctokitClient["rest"]["issues"]["addAssignees"]
>;

const addIssueAssignees: AddIssueAssigneesTask = {
  onError,
  run: async (params, client, task, io) => {
    return client.rest.issues
      .addAssignees({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        assignees: params.assignees,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Add Issue Assignees",
      params,
      properties: [
        ...repoProperties(params),
        ...issueProperties(params),
        {
          label: "assignees",
          text: params.assignees.join(", "),
        },
      ],
    };
  },
};

type AddIssueLabelsTask = GithubAuthenticatedTask<
  { owner: string; repo: string; issueNumber: number; labels: string[] },
  OctokitClient["rest"]["issues"]["addLabels"]
>;

const addIssueLabels: AddIssueLabelsTask = {
  onError,
  run: async (params, client, task, io) => {
    return client.rest.issues
      .addLabels({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        labels: params.labels,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Add Issue Labels",
      params,
      properties: [
        ...repoProperties(params),
        ...issueProperties(params),
        {
          label: "Labels",
          text: params.labels.join(", "),
        },
      ],
    };
  },
};

const createIssueComment: GithubAuthenticatedTask<
  { body: string; owner: string; repo: string; issueNumber: number },
  OctokitClient["rest"]["issues"]["createComment"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.issues
      .createComment({
        owner: params.owner,
        repo: params.repo,
        body: params.body,
        issue_number: params.issueNumber,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      properties: [...repoProperties(params), ...issueProperties(params)],
    };
  },
};

const getIssue: GithubAuthenticatedTask<
  { owner: string; repo: string; issueNumber: number },
  OctokitClient["rest"]["issues"]["get"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.issues
      .get({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Get Issue",
      params,
      properties: [...repoProperties(params), ...issueProperties(params)],
    };
  },
};

const getRepo: GithubAuthenticatedTask<
  { owner: string; repo: string },
  OctokitClient["rest"]["repos"]["get"]
> = {
  onError,
  run: async (params, client, task) => {
    const response = await client.rest.repos.get({
      owner: params.owner,
      repo: params.repo,
      headers: {
        "x-trigger-attempt": String(task.attempts),
      },
    });

    return response.data;
  },
  init: (params) => {
    return {
      name: "Get Repo",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
      ],
    };
  },
};

type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

const addIssueCommentReaction: GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    commentId: number;
    content: ReactionContent;
  },
  OctokitClient["rest"]["reactions"]["createForIssueComment"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.reactions
      .createForIssueComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: params.commentId,
        content: params.content,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    let emoji = "";

    switch (params.content) {
      case "+1":
        emoji = "👍";
        break;
      case "-1":
        emoji = "👎";
        break;
      case "laugh":
        emoji = "😄";
        break;
      case "confused":
        emoji = "😕";
        break;
      case "heart":
        emoji = "❤️";
        break;
      case "hooray":
        emoji = "🎉";
        break;
      case "rocket":
        emoji = "🚀";
        break;
      case "eyes":
        emoji = "👀";
        break;
    }

    return {
      name: "Add Issue Reaction",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Comment",
          text: `#${params.commentId}`,
        },
        { label: "reaction", text: emoji },
      ],
    };
  },
};

const createIssueCommentWithReaction: GithubAuthenticatedTask<
  {
    body: string;
    owner: string;
    repo: string;
    issueNumber: number;
    reaction: ReactionContent;
  },
  OctokitClient["rest"]["issues"]["createComment"]
> = {
  onError,
  run: async (params, client, task, io, auth) => {
    const comment = await io.runTask(
      `Comment on Issue #${params.issueNumber}`,
      async (t) => {
        return createIssueComment.run(params, client, t, io, auth);
      },
      createIssueComment.init(params)
    );

    await io.runTask(
      `React with ${params.reaction}`,
      async (t) => {
        return addIssueCommentReaction.run(
          {
            owner: params.owner,
            repo: params.repo,
            commentId: comment.id,
            content: params.reaction,
          },
          client,
          t,
          io,
          auth
        );
      },
      addIssueCommentReaction.init({
        owner: params.owner,
        repo: params.repo,
        commentId: comment.id,
        content: params.reaction,
      })
    );

    return comment;
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Issue",
          text: `#${params.issueNumber}`,
        },
      ],
    };
  },
};

const updateWebhook: GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    hookId: number;
    url: string;
    secret: string;
    addEvents?: string[];
  },
  OctokitClient["rest"]["repos"]["updateWebhook"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.repos
      .updateWebhook({
        owner: params.owner,
        repo: params.repo,
        hook_id: params.hookId,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        add_events: params.addEvents,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Update Webhook",
      params,
      properties: [
        {
          label: "Owner",
          text: params.owner,
        },
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Hook ID",
          text: String(params.hookId),
        },
      ],
    };
  },
};

const updateOrgWebhook: GithubAuthenticatedTask<
  {
    org: string;
    hookId: number;
    url: string;
    secret: string;
    addEvents?: string[];
  },
  OctokitClient["rest"]["orgs"]["updateWebhook"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.orgs
      .updateWebhook({
        org: params.org,
        hook_id: params.hookId,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        add_events: params.addEvents,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Update Org Webhook",
      params,
      properties: [
        {
          label: "Org",
          text: params.org,
        },
        {
          label: "Hook ID",
          text: String(params.hookId),
        },
      ],
    };
  },
};

const createWebhook: GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    url: string;
    secret: string;
    events: string[];
  },
  OctokitClient["rest"]["repos"]["createWebhook"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.repos
      .createWebhook({
        owner: params.owner,
        repo: params.repo,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        events: params.events,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Webhook",
      params,
      properties: [
        {
          label: "Owner",
          text: params.owner,
        },
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Events",
          text: params.events.join(", "),
        },
      ],
    };
  },
};

const createOrgWebhook: GithubAuthenticatedTask<
  {
    org: string;
    url: string;
    secret: string;
    events: string[];
  },
  OctokitClient["rest"]["orgs"]["createWebhook"]
> = {
  onError,
  run: async (params, client, task) => {
    return client.rest.orgs
      .createWebhook({
        org: params.org,
        name: "web",
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        events: params.events,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Org Webhook",
      params,
      properties: [
        {
          label: "Org",
          text: params.org,
        },
        {
          label: "Events",
          text: params.events.join(", "),
        },
      ],
    };
  },
};

const listWebhooks: GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
  },
  OctokitClient["rest"]["repos"]["listWebhooks"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.repos
      .listWebhooks({
        owner: params.owner,
        repo: params.repo,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "List Webhooks",
      params,
      properties: [
        {
          label: "Owner",
          text: params.owner,
        },
        {
          label: "Repo",
          text: params.repo,
        },
      ],
    };
  },
};

const listOrgWebhooks: GithubAuthenticatedTask<
  {
    org: string;
  },
  OctokitClient["rest"]["orgs"]["listWebhooks"]
> = {
  onError,
  run: async (params, client) => {
    return client.rest.orgs
      .listWebhooks({
        org: params.org,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "List Org Webhooks",
      params,
      properties: [
        {
          label: "Org",
          text: params.org,
        },
      ],
    };
  },
};

type Endcoding = "utf-8" | "base-64";

type CreateBlobTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    content: string;
    encoding?: Endcoding;
  },
  OctokitClient["rest"]["git"]["createBlob"]
>;
const createBlob: CreateBlobTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .createBlob({
        owner: params.owner,
        repo: params.repo,
        content: params.content,
        encoding: params.encoding,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Blob",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Content",
          text: params.content,
        },
      ],
    };
  },
};

type GetBlobTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    fileSHA: string;
  },
  OctokitClient["rest"]["git"]["getBlob"]
>;

const getBlob: GetBlobTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .getBlob({
        owner: params.owner,
        repo: params.repo,
        file_sha: params.fileSHA,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Get Blob",
      params,
      properties: [...repoProperties(params)],
    };
  },
};

type AuthorContent = {
  name: string;
  email: string;
  date?: string;
};

type CommitterContent = {
  name?: string;
  email?: string;
  date?: string;
};

type CreateCommitTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents?: string[];
    author?: AuthorContent;
    committer?: CommitterContent;
    signature?: string;
  },
  OctokitClient["rest"]["git"]["createCommit"]
>;

const createCommit: CreateCommitTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .createCommit({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Commit",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Message",
          text: params.message,
        },
        {
          label: "Tree",
          text: params.tree,
        },
      ],
    };
  },
};

type GetCommitTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    commitSHA: string;
  },
  OctokitClient["rest"]["git"]["getCommit"]
>;

const getCommit: GetCommitTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .getCommit({
        owner: params.owner,
        repo: params.repo,
        commit_sha: params.commitSHA,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Get Commit",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Commit SHA",
          text: params.commitSHA,
        },
      ],
    };
  },
};

type ListMatchingReferencesTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    ref: string;
  },
  OctokitClient["rest"]["git"]["listMatchingRefs"]
>;
const listMatchingReferences: ListMatchingReferencesTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .listMatchingRefs({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "List Matching References",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Ref",
          text: params.ref,
        },
      ],
    };
  },
};

type GetReferenceTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    ref: string;
  },
  OctokitClient["rest"]["git"]["getRef"]
>;

const getReference: GetReferenceTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .getRef({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Get Reference",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Ref",
          text: params.ref,
        },
      ],
    };
  },
};

type CreateReferenceTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
  },
  OctokitClient["rest"]["git"]["createRef"]
>;

const createReference: CreateReferenceTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .createRef({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Reference",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Ref",
          text: params.ref,
        },
        {
          label: "SHA",
          text: params.ref,
        },
      ],
    };
  },
};

type UpdateReferenceTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
  },
  OctokitClient["rest"]["git"]["updateRef"]
>;

const updateReference: UpdateReferenceTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .updateRef({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Update Reference",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Ref",
          text: params.ref,
        },
        {
          label: "SHA",
          text: params.ref,
        },
      ],
    };
  },
};

type DeleteReferenceTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    ref: string;
  },
  OctokitClient["rest"]["git"]["deleteRef"]
>;

const deleteReference: DeleteReferenceTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .deleteRef({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Delete Reference",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Ref",
          text: params.ref,
        },
      ],
    };
  },
};

type TagType = "commit" | "tree" | "blob";
type TaggerContent = {
  name: string;
  email: string;
  date?: string;
};
type CreateTagTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    tag: string;
    message: string;
    object: string;
    type: TagType;
    tagger?: TaggerContent;
  },
  OctokitClient["rest"]["git"]["createTag"]
>;

const createTag: CreateTagTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .createTag({
        ...params,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Tag",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Tag",
          text: params.tag,
        },
        {
          label: "Message",
          text: params.message,
        },
        {
          label: "Object",
          text: params.object,
        },
        {
          label: "Tag Type",
          text: params.type,
        },
      ],
    };
  },
};

type GetTagTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    tagSHA: string;
  },
  OctokitClient["rest"]["git"]["getTag"]
>;

const getTag: GetTagTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .getTag({
        owner: params.owner,
        repo: params.repo,
        tag_sha: params.tagSHA,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Get Tag",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Tag SHA",
          text: params.tagSHA,
        },
      ],
    };
  },
};

type TreeType = {
  path?: string | undefined;
  mode?: "100644" | "100755" | "040000" | "160000" | "120000" | undefined;
  type?: "commit" | "tree" | "blob" | undefined;
  sha?: string | null | undefined;
  content?: string | undefined;
};

type CreateTreeTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    tree: TreeType[];
    baseTree?: string;
  },
  OctokitClient["rest"]["git"]["createTree"]
>;

const createTree: CreateTreeTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .createTree({
        owner: params.owner,
        repo: params.repo,
        tree: params.tree,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Tree",
      params,
      properties: [...repoProperties(params)],
    };
  },
};

type GetTreeTask = GithubAuthenticatedTask<
  {
    owner: string;
    repo: string;
    treeSHA: string;
    recursive?: string;
  },
  OctokitClient["rest"]["git"]["getTree"]
>;

const getTree: GetTreeTask = {
  onError,
  run: async (params, client) => {
    return client.rest.git
      .getTree({
        owner: params.owner,
        repo: params.repo,
        tree_sha: params.treeSHA,
        recursive: params.recursive,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Get Tree",
      params,
      properties: [
        ...repoProperties(params),
        {
          label: "Tree SHA",
          text: params.treeSHA,
        },
      ],
    };
  },
};

export const tasks = {
  createIssue,
  addIssueAssignees,
  addIssueLabels,
  createIssueComment,
  getIssue,
  getRepo,
  createIssueCommentWithReaction,
  addIssueCommentReaction,
  updateWebhook,
  createWebhook,
  listWebhooks,
  updateOrgWebhook,
  createOrgWebhook,
  listOrgWebhooks,
  createBlob,
  getBlob,
  createCommit,
  getCommit,
  listMatchingReferences,
  getReference,
  createReference,
  updateReference,
  deleteReference,
  createTag,
  getTag,
  createTree,
  getTree,
};

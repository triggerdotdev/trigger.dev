import { RequestError } from "@octokit/request-error";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import type { AuthenticatedTask } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { issueProperties, repoProperties } from "./propertyHelpers";

type OctokitClient = InstanceType<typeof Octokit>;

type GithubAuthenticatedTask<
  TParams extends Record<string, unknown>,
  TFunction extends (...args: any[]) => any
> = AuthenticatedTask<
  OctokitClient,
  TParams,
  GetResponseDataTypeFromEndpointMethod<TFunction>
>;

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

type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

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
      createIssueComment.init(params),
      async (t) => {
        return createIssueComment.run(params, client, t, io, auth);
      }
    );

    await io.runTask(
      `React with ${params.reaction}`,
      addIssueCommentReaction.init({
        owner: params.owner,
        repo: params.repo,
        commentId: comment.id,
        content: params.reaction,
      }),
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
      }
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
};

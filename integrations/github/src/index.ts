import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
} from "@octokit/webhooks-types";
import type { Connection, EventFilter } from "@trigger.dev/sdk";
import { ExternalSourceEventTrigger, Trigger } from "@trigger.dev/sdk/triggers";
import { Octokit } from "octokit";
import { clientFactory } from "./clientFactory";
import { metadata } from "./metadata";
import { repositoryWebhookSource } from "./sources";
import {
  createIssue,
  createIssueComment,
  createIssueCommentWithReaction,
  getRepo,
} from "./tasks";
import { ClientOptions } from "./types";

const tasks = {
  createIssue,
  createIssueComment,
  getRepo,
  createIssueCommentWithReaction,
};

export type GitHubConnectionOptions =
  | {
      token: string;
    }
  | {
      id: string;
    };

export const github = (options: GitHubConnectionOptions) => {
  if ("token" in options) {
    const client = new Octokit({
      auth: options.token,
    });

    return {
      metadata,
      tasks,
      usesLocalAuth: true,
      client,
      triggers: createTriggers({ usesLocalAuth: true, octokit: client }),
    } satisfies Connection<Octokit, typeof tasks>;
  }

  return {
    id: options.id,
    metadata,
    tasks,
    usesLocalAuth: false,
    clientFactory,
    triggers: createTriggers(
      { usesLocalAuth: false, clientFactory },
      options.id
    ),
  } satisfies Connection<Octokit, typeof tasks>;
};
0;
function createTriggers(client: ClientOptions, id?: string) {
  return {
    onIssue: buildRepoWebhookTrigger<IssuesEvent>(
      "On Issue",
      "issues",
      client,
      id
    ),
    onIssueOpened: buildRepoWebhookTrigger<IssuesOpenedEvent>(
      "On Issue Opened",
      "issues",
      client,
      id,
      {
        action: ["opened"],
      }
    ),
    onIssueComment: buildRepoWebhookTrigger<IssueCommentEvent>(
      "On Issue Comment",
      "issue_comment",
      client,
      id
    ),
  };
}

function buildRepoWebhookTrigger<TEventType>(
  title: string,
  event: string,
  client: ClientOptions,
  id?: string,
  filter?: EventFilter
): (params: { repo: string }) => ExternalSourceEventTrigger<TEventType> {
  return (params: { repo: string }) =>
    new ExternalSourceEventTrigger<TEventType>({
      title,
      elements: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Event",
          text: event,
        },
      ],
      source: repositoryWebhookSource(
        {
          repo: params.repo,
          events: [event],
        },
        client,
        id
      ),
      eventRule: {
        event,
        source: "github.com",
        payload: filter ?? {},
      },
    });
}

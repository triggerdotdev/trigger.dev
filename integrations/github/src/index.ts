import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
  StarEvent,
} from "@octokit/webhooks-types";
import {
  Connection,
  EventFilter,
  ExternalSourceEventTrigger,
} from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { clientFactory } from "./clientFactory";
import { metadata } from "./metadata";
import { repositoryWebhookSource } from "./sources";
import { tasks } from "./tasks";

export type GitHubConnectionOptions =
  | {
      token: string;
    }
  | {
      id: string;
    };

export const github = (options: GitHubConnectionOptions) => {
  const connection = createConnectionFromOptions(options);

  return {
    ...connection,
    triggers: createTriggers(connection),
  };
};

function createConnectionFromOptions(
  options: GitHubConnectionOptions
): Connection<Octokit, typeof tasks> {
  if ("token" in options) {
    const client = new Octokit({
      auth: options.token,
    });

    return {
      metadata,
      tasks,
      usesLocalAuth: true,
      client,
    };
  }

  return {
    id: options.id,
    metadata,
    tasks,
    usesLocalAuth: false,
    clientFactory,
  };
}

function createTriggers(connection: Connection<Octokit, typeof tasks>) {
  return {
    onIssue: buildRepoWebhookTrigger<IssuesEvent>(
      "On Issue",
      "issues",
      connection
    ),
    onIssueOpened: buildRepoWebhookTrigger<IssuesOpenedEvent>(
      "On Issue Opened",
      "issues",
      connection,
      {
        action: ["opened"],
      }
    ),
    onStar: buildRepoWebhookTrigger<StarEvent>("On Star", "star", connection),
  };
}

function buildRepoWebhookTrigger<TEvent>(
  title: string,
  event: string,
  connection: Connection<Octokit, typeof tasks>,
  filter?: EventFilter
) {
  return (params: { repo: string }) =>
    new ExternalSourceEventTrigger({
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
        connection,
        (payload) => payload as TEvent
      ),
      eventRule: {
        event,
        source: "github.com",
        payload: filter ?? {},
      },
    });
}

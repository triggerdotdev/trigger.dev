import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
} from "@octokit/webhooks-types";
import type { Connection, EventFilter } from "@trigger.dev/sdk";
import { ExternalSourceEventTrigger, Trigger } from "@trigger.dev/sdk/triggers";
import { Octokit } from "octokit";
import { metadata } from "./metadata";
import { repositoryWebhookSource } from "./sources";
import {
  createIssue,
  createIssueComment,
  createIssueCommentWithReaction,
  getRepo,
} from "./tasks";

const tasks = {
  createIssue,
  createIssueComment,
  getRepo,
  createIssueCommentWithReaction,
};

function createTriggers(client: Octokit) {
  return {
    onIssue: buildRepoWebhookTrigger<IssuesEvent>("On Issue", "issues", client),
    onIssueOpened: buildRepoWebhookTrigger<IssuesOpenedEvent>(
      "On Issue Opened",
      "issues",
      client,
      {
        action: ["opened"],
      }
    ),
    onIssueComment: buildRepoWebhookTrigger<IssueCommentEvent>(
      "On Issue Comment",
      "issue_comment",
      client
    ),
  };
}

export const github = (options: { token: string }) => {
  const client = new Octokit({
    auth: options.token,
  });

  return {
    metadata,
    tasks,
    usesLocalAuth: true,
    client,
    triggers: createTriggers(client),
  } satisfies Connection<Octokit, typeof tasks>;
};

function buildRepoWebhookTrigger<TEventType>(
  title: string,
  event: string,
  client: Octokit,
  filter?: EventFilter
): (params: { repo: string }) => Trigger<TEventType> {
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
        client
      ),
      eventRule: {
        event,
        source: "github.com",
        payload: filter ?? {},
      },
    });
}

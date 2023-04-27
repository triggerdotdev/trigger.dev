import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
} from "@octokit/webhooks-types";
import type { EventFilter } from "@trigger.dev/sdk";
import { ExternalSourceEventTrigger, Trigger } from "@trigger.dev/sdk/triggers";
import { clientFactory as cf } from "./client";
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

export const github = (options?: { token: string }) => {
  const clientFactory = options?.token
    ? () => cf({ type: "apiKey", apiKey: options.token })
    : cf;

  return {
    metadata,
    tasks,
    usesLocalAuth: typeof options?.token === "string",
    clientFactory,
    onIssue: buildRepoWebhookTrigger<IssuesEvent>(
      "On Issue",
      "issues",
      options
    ),
    onIssueOpened: buildRepoWebhookTrigger<IssuesOpenedEvent>(
      "On Issue Opened",
      "issues",
      options,
      {
        action: ["opened"],
      }
    ),
    onIssueComment: buildRepoWebhookTrigger<IssueCommentEvent>(
      "On Issue Comment",
      "issue_comment",
      options
    ),
  };
};

function buildRepoWebhookTrigger<TEventType>(
  title: string,
  event: string,
  options?: { token: string },
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
        { token: options?.token }
      ),
      eventRule: {
        event,
        source: "github.com",
        payload: filter ?? {},
      },
    });
}

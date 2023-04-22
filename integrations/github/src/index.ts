import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
  PushEvent,
} from "@octokit/webhooks-types";
import type { EventFilter } from "@trigger.dev/sdk";
import { ExternalSourceEventTrigger, Trigger } from "@trigger.dev/sdk/triggers";
import { clientFactory as cf } from "./client";
import { metadata } from "./metadata";
import { repositoryWebhookSource } from "./sources";
import { createIssue, createIssueComment, getRepo } from "./tasks";

const tasks = {
  createIssue,
  createIssueComment,
  getRepo,
};

export const github = (options?: { token: string }) => {
  const clientFactory = options?.token
    ? () => cf({ type: "apiKey", apiKey: options.token })
    : cf;

  return {
    metadata,
    tasks,
    hasLocalAuth: typeof options?.token === "string",
    clientFactory,
    onIssue: buildRepoWebhookTrigger<IssuesEvent>(
      "On Issue",
      ["issues"],
      options
    ),
    onIssueOpened: buildRepoWebhookTrigger<IssuesOpenedEvent>(
      "On Issue Opened",
      ["issues"],
      options,
      {
        action: ["opened"],
      }
    ),
    onIssueComment: buildRepoWebhookTrigger<IssueCommentEvent>(
      "On Issue Comment",
      ["issue_comment"],
      options
    ),
  };
};

function buildRepoWebhookTrigger<TEventType>(
  title: string,
  events: string[],
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
      ],
      source: repositoryWebhookSource(
        {
          repo: params.repo,
          events,
        },
        { token: options?.token }
      ),
      filter: {
        name: events,
        payload: filter ?? {},
      },
    });
}

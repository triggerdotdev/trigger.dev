import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
  StarCreatedEvent,
  StarEvent,
} from "@octokit/webhooks-types";
import {
  Connection,
  EventSpecification,
  ExternalSourceTrigger,
} from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { clientFactory } from "./clientFactory";
import { metadata } from "./metadata";
import { createOrgEventSource, createRepoEventSource } from "./sources";
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

  const repoSource = createRepoEventSource(connection);
  const orgSource = createOrgEventSource(connection);
  const repoTrigger = createRepoTrigger(repoSource);
  const orgTrigger = createOrgTrigger(orgSource);

  return {
    ...connection,
    sources: {
      repo: repoSource,
      org: orgSource,
    },
    triggers: {
      repo: repoTrigger,
      org: orgTrigger,
    },
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

const onIssueOpened: EventSpecification<IssuesOpenedEvent> = {
  name: "issues",
  title: "On issue opened",
  source: "github.com",
  filter: {
    action: ["opened"],
  },
  parsePayload: (payload) => payload as IssuesOpenedEvent,
};

const onIssue: EventSpecification<IssuesEvent> = {
  name: "issues",
  title: "On issue",
  source: "github.com",
  parsePayload: (payload) => payload as IssuesEvent,
};

const onIssueComment: EventSpecification<IssueCommentEvent> = {
  name: "issue_comment",
  title: "On issue comment",
  source: "github.com",
  parsePayload: (payload) => payload as IssueCommentEvent,
};

const onStar: EventSpecification<StarEvent> = {
  name: "star",
  title: "On star",
  source: "github.com",
  parsePayload: (payload) => payload as StarEvent,
};

const onNewStar: EventSpecification<StarCreatedEvent> = {
  name: "star",
  title: "On new star",
  source: "github.com",
  filter: {
    action: ["created"],
  },
  parsePayload: (payload) => payload as StarCreatedEvent,
};

export const events = {
  onIssueOpened,
  onIssue,
  onIssueComment,
  onStar,
  onNewStar,
};

// params.event has to be a union of all the values of the exports events object
type GitHubEvents = (typeof events)[keyof typeof events];

function createRepoTrigger(source: ReturnType<typeof createRepoEventSource>) {
  return <TEventSpecification extends GitHubEvents>({
    event,
    repo,
  }: {
    event: TEventSpecification;
    repo: string;
  }) => {
    return new ExternalSourceTrigger({
      event,
      params: { repo },
      source,
      filter: {
        repository: {
          full_name: [repo],
        },
      },
    });
  };
}

function createOrgTrigger(source: ReturnType<typeof createOrgEventSource>) {
  return <TEventSpecification extends GitHubEvents>({
    event,
    org,
  }: {
    event: TEventSpecification;
    org: string;
  }) => {
    return new ExternalSourceTrigger({
      event,
      params: { org },
      source,
      filter: {
        organization: {
          login: [org],
        },
      },
    });
  };
}

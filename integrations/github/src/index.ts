import {
  IssueCommentEvent,
  IssuesEvent,
  IssuesOpenedEvent,
  RepositoryCreatedEvent,
  StarCreatedEvent,
  StarEvent,
} from "@octokit/webhooks-types";
import {
  IntegrationClient,
  EventSpecification,
  ExternalSourceTrigger,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { clientFactory } from "./clientFactory";
import { createOrgEventSource, createRepoEventSource } from "./sources";
import { tasks } from "./tasks";

export type GithubIntegrationOptions = {
  id: string;
  token?: string;
};

type GithubSources = {
  repo: ReturnType<typeof createRepoEventSource>;
  org: ReturnType<typeof createOrgEventSource>;
};

type GithubTriggers = {
  repo: ReturnType<typeof createRepoTrigger>;
  org: ReturnType<typeof createOrgTrigger>;
};

export class Github
  implements TriggerIntegration<IntegrationClient<Octokit, typeof tasks>>
{
  client: IntegrationClient<Octokit, typeof tasks>;
  _repoSource: ReturnType<typeof createRepoEventSource>;
  _orgSource: ReturnType<typeof createOrgEventSource>;
  _repoTrigger: ReturnType<typeof createRepoTrigger>;
  _orgTrigger: ReturnType<typeof createOrgTrigger>;

  constructor(private options: GithubIntegrationOptions) {
    this.client = createConnectionFromOptions(options);
    this._repoSource = createRepoEventSource(this);
    this._orgSource = createOrgEventSource(this);
    this._repoTrigger = createRepoTrigger(this._repoSource);
    this._orgTrigger = createOrgTrigger(this._orgSource);
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { key: "github", title: "GitHub", icon: "github" };
  }

  get sources(): GithubSources {
    return {
      repo: this._repoSource,
      org: this._orgSource,
    };
  }

  get triggers(): GithubTriggers {
    return {
      repo: this._repoTrigger,
      org: this._orgTrigger,
    };
  }
}

function createConnectionFromOptions(
  options: GithubIntegrationOptions
): IntegrationClient<Octokit, typeof tasks> {
  if (options.token) {
    const client = new Octokit({
      auth: options.token,
    });

    return {
      usesLocalAuth: true,
      client,
      tasks,
    };
  }

  return {
    usesLocalAuth: false,
    clientFactory,
    tasks,
  };
}

const onIssueOpened: EventSpecification<IssuesOpenedEvent> = {
  name: "issues",
  title: "On issue opened",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["opened"],
  },
  parsePayload: (payload) => payload as IssuesOpenedEvent,
  runProperties: (payload) => [
    {
      label: "Issue",
      text: `#${payload.issue.number}: ${payload.issue.title}`,
      url: payload.issue.html_url,
    },
    {
      label: "Author",
      text: payload.sender.login,
      url: payload.sender.html_url,
    },
  ],
};

const onIssue: EventSpecification<IssuesEvent> = {
  name: "issues",
  title: "On issue",
  source: "github.com",
  icon: "github",
  parsePayload: (payload) => payload as IssuesEvent,
  runProperties: (payload) => [
    {
      label: "Issue",
      text: `#${payload.issue.number}: ${payload.issue.title}`,
      url: payload.issue.html_url,
    },
    {
      label: "Author",
      text: payload.sender.login,
      url: payload.sender.html_url,
    },
  ],
};

const onIssueComment: EventSpecification<IssueCommentEvent> = {
  name: "issue_comment",
  title: "On issue comment",
  source: "github.com",
  icon: "github",
  parsePayload: (payload) => payload as IssueCommentEvent,
  runProperties: (payload) => [
    {
      label: "Issue",
      text: `#${payload.issue.number}: ${payload.issue.title}`,
      url: payload.issue.html_url,
    },
    {
      label: "Author",
      text: payload.sender.login,
      url: payload.sender.html_url,
    },
  ],
};

const onStar: EventSpecification<StarEvent> = {
  name: "star",
  title: "On star",
  source: "github.com",
  icon: "github",
  parsePayload: (payload) => payload as StarEvent,
};

const onNewStar: EventSpecification<StarCreatedEvent> = {
  name: "star",
  title: "On new star",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["created"],
  },
  parsePayload: (payload) => payload as StarCreatedEvent,
};

const onNewRepository: EventSpecification<RepositoryCreatedEvent> = {
  name: "repository",
  title: "On new repository",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["created"],
  },
  parsePayload: (payload) => payload as RepositoryCreatedEvent,
};

export const events = {
  onIssueOpened,
  onIssue,
  onIssueComment,
  onStar,
  onNewStar,
  onNewRepository,
};

// params.event has to be a union of all the values of the exports events object
type GitHubEvents = (typeof events)[keyof typeof events];

type CreateRepoTriggerReturnType = <
  TEventSpecification extends GitHubEvents
>(args: {
  event: TEventSpecification;
  repo: string;
}) => ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createRepoEventSource>
>;

function createRepoTrigger(
  source: ReturnType<typeof createRepoEventSource>
): CreateRepoTriggerReturnType {
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
    });
  };
}

type CreateOrgTriggerReturnType = <
  TEventSpecification extends GitHubEvents
>(args: {
  event: TEventSpecification;
  org: string;
}) => ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createOrgEventSource>
>;

function createOrgTrigger(
  source: ReturnType<typeof createOrgEventSource>
): CreateOrgTriggerReturnType {
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
    });
  };
}

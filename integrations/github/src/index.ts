import { RequestRequestOptions } from "@octokit/types";
import {
  CreateEvent,
  IssueCommentEvent,
  IssuesAssignedEvent,
  IssuesEvent,
  IssuesOpenedEvent,
  RepositoryCreatedEvent,
  StarCreatedEvent,
  StarEvent,
} from "@octokit/webhooks-types";
import {
  EventSpecification,
  ExternalSourceTrigger,
  IntegrationClient,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { createOrgEventSource, createRepoEventSource } from "./sources";
import { tasks } from "./tasks";
import {
  issueAssigned,
  issueCommentCreated,
  issueOpened,
  newBranch,
  starredRepo,
} from "./webhook-examples";
import { truncate } from "@trigger.dev/integration-kit";

export type GithubIntegrationOptions = {
  id: string;
  token?: string;
  octokitRequest?: RequestRequestOptions;
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
    this.client = createClientFromOptions(options);
    this._repoSource = createRepoEventSource(this);
    this._orgSource = createOrgEventSource(this);
    this._repoTrigger = createRepoTrigger(this._repoSource);
    this._orgTrigger = createOrgTrigger(this._orgSource);
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { name: "GitHub", id: "github" };
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

function createClientFromOptions(
  options: GithubIntegrationOptions
): IntegrationClient<Octokit, typeof tasks> {
  if (options.token) {
    const client = new Octokit({
      auth: options.token,
      request: options.octokitRequest,
      retry: {
        enabled: false,
      },
    });

    return {
      usesLocalAuth: true,
      client,
      tasks,
      auth: options.token,
    };
  }

  return {
    usesLocalAuth: false,
    clientFactory: (auth) => {
      return new Octokit({
        auth: auth.accessToken,
        request: options.octokitRequest,
        retry: {
          enabled: false,
        },
      });
    },
    tasks,
  };
}

const onIssue: EventSpecification<IssuesEvent> = {
  name: "issues",
  title: "On issue",
  source: "github.com",
  icon: "github",
  examples: [issueOpened, issueAssigned],
  parsePayload: (payload) => payload as IssuesEvent,
  runProperties: (payload) => issueProperties(payload),
};

const onIssueOpened: EventSpecification<IssuesOpenedEvent> = {
  name: "issues",
  title: "On issue opened",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["opened"],
  },
  examples: [issueOpened],
  parsePayload: (payload) => payload as IssuesOpenedEvent,
  runProperties: (payload) => issueProperties(payload),
};

const onIssueAssigned: EventSpecification<IssuesAssignedEvent> = {
  name: "issues",
  title: "On issue assigned",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["assigned"],
  },
  examples: [issueAssigned],
  parsePayload: (payload) => payload as IssuesAssignedEvent,
  runProperties: (payload) => [
    ...issueProperties(payload),
    {
      label: "Assignee",
      text: payload.assignee?.login ?? "none",
      url: payload.assignee?.html_url,
    },
  ],
};

const onIssueComment: EventSpecification<IssueCommentEvent> = {
  name: "issue_comment",
  title: "On issue comment",
  source: "github.com",
  icon: "github",
  examples: [issueCommentCreated],
  parsePayload: (payload) => payload as IssueCommentEvent,
  runProperties: (payload) => [
    ...issueProperties(payload),
    {
      label: "Comment body",
      text: truncate(payload.comment.body, 40),
      url: payload.comment.html_url,
    },
  ],
};

function issueProperties(payload: IssuesEvent | IssueCommentEvent) {
  return [
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
  ];
}

const onStar: EventSpecification<StarEvent> = {
  name: "star",
  title: "On star",
  source: "github.com",
  icon: "github",
  examples: [starredRepo],
  parsePayload: (payload) => payload as StarEvent,
  runProperties: (payload) => starProperties(payload),
};

const onNewStar: EventSpecification<StarCreatedEvent> = {
  name: "star",
  title: "On new star",
  source: "github.com",
  icon: "github",
  filter: {
    action: ["created"],
  },
  examples: [starredRepo],
  parsePayload: (payload) => payload as StarCreatedEvent,
  runProperties: (payload) => starProperties(payload),
};

function starProperties(payload: StarEvent) {
  return [
    {
      label: "Repo",
      text: `${payload.repository.name}`,
      url: payload.repository.url,
    },
    {
      label: "Author",
      text: payload.sender.login,
      url: payload.sender.html_url,
    },
    {
      label: "Star count",
      text: `${payload.repository.stargazers_count}`,
      url: payload.repository.stargazers_url,
    },
  ];
}

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

const onNewBranchOrTag: EventSpecification<CreateEvent> = {
  name: "create",
  title: "On new branch or tag",
  source: "github.com",
  icon: "github",
  parsePayload: (payload) => payload as CreateEvent,
  runProperties: (payload) => branchTagProperties(payload),
};

const onNewBranch: EventSpecification<CreateEvent> = {
  name: "create",
  title: "On new branch tag",
  source: "github.com",
  icon: "github",
  filter: {
    ref_type: ["branch"],
  },
  examples: [newBranch],
  parsePayload: (payload) => payload as CreateEvent,
  runProperties: (payload) => branchTagProperties(payload),
};

const onNewTag: EventSpecification<CreateEvent> = {
  name: "create",
  title: "On new tag",
  source: "github.com",
  icon: "github",
  filter: {
    ref_type: ["tag"],
  },
  parsePayload: (payload) => payload as CreateEvent,
  runProperties: (payload) => branchTagProperties(payload),
};

function branchTagProperties(payload: CreateEvent) {
  return [
    {
      label: "Repo",
      text: payload.repository.name,
      url: payload.repository.url,
    },
    {
      label: payload.ref_type === "branch" ? "Branch" : "Tag",
      text: payload.ref,
    },
  ];
}

export const events = {
  /** When any action is performed on an issue  */
  onIssue,
  /** When an issue is opened  */
  onIssueOpened,
  /** When an issue is assigned  */
  onIssueAssigned,
  /** When an issue is commented on  */
  onIssueComment,
  /** When a repo is starred or unstarred  */
  onStar,
  /** When a repo is starred  */
  onNewStar,
  /** When a new repo is created  */
  onNewRepository,
  /** When a new branch or tag is created  */
  onNewBranchOrTag,
  /** When a new branch is created  */
  onNewBranch,
  /** When a new tag is created  */
  onNewTag,
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

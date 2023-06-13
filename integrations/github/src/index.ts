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
  examples: [
    {
      id: "issues_1",
      name: "Issue opened",
      payload: {
        issue: {
          id: 1754473379,
          url: "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21",
          body: 'This is a *big* problem:\r\n\r\n```\r\nconst foo = "bar"\r\n```',
          user: {
            id: 10635986,
            url: "https://api.github.com/users/matt-aitken",
            type: "User",
            login: "matt-aitken",
            node_id: "MDQ6VXNlcjEwNjM1OTg2",
            html_url: "https://github.com/matt-aitken",
            gists_url:
              "https://api.github.com/users/matt-aitken/gists{/gist_id}",
            repos_url: "https://api.github.com/users/matt-aitken/repos",
            avatar_url: "https://avatars.githubusercontent.com/u/10635986?v=4",
            events_url:
              "https://api.github.com/users/matt-aitken/events{/privacy}",
            site_admin: false,
            gravatar_id: "",
            starred_url:
              "https://api.github.com/users/matt-aitken/starred{/owner}{/repo}",
            followers_url: "https://api.github.com/users/matt-aitken/followers",
            following_url:
              "https://api.github.com/users/matt-aitken/following{/other_user}",
            organizations_url: "https://api.github.com/users/matt-aitken/orgs",
            subscriptions_url:
              "https://api.github.com/users/matt-aitken/subscriptions",
            received_events_url:
              "https://api.github.com/users/matt-aitken/received_events",
          },
          state: "open",
          title: "This is a sample issue title #20",
          labels: [],
          locked: false,
          number: 21,
          node_id: "I_kwDOI-yZFc5okyOj",
          assignee: null,
          comments: 0,
          html_url: "https://github.com/ericallam/basic-starter-12k/issues/21",
          assignees: [],
          closed_at: null,
          milestone: null,
          reactions: {
            "+1": 0,
            "-1": 0,
            url: "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21/reactions",
            eyes: 0,
            heart: 0,
            laugh: 0,
            hooray: 0,
            rocket: 0,
            confused: 0,
            total_count: 0,
          },
          created_at: "2023-06-13T09:42:02Z",
          events_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21/events",
          labels_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21/labels{/name}",
          updated_at: "2023-06-13T09:42:02Z",
          comments_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21/comments",
          state_reason: null,
          timeline_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/21/timeline",
          repository_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k",
          active_lock_reason: null,
          author_association: "NONE",
          performed_via_github_app: null,
        },
        action: "opened",
        sender: {
          id: 10635986,
          url: "https://api.github.com/users/matt-aitken",
          type: "User",
          login: "matt-aitken",
          node_id: "MDQ6VXNlcjEwNjM1OTg2",
          html_url: "https://github.com/matt-aitken",
          gists_url: "https://api.github.com/users/matt-aitken/gists{/gist_id}",
          repos_url: "https://api.github.com/users/matt-aitken/repos",
          avatar_url: "https://avatars.githubusercontent.com/u/10635986?v=4",
          events_url:
            "https://api.github.com/users/matt-aitken/events{/privacy}",
          site_admin: false,
          gravatar_id: "",
          starred_url:
            "https://api.github.com/users/matt-aitken/starred{/owner}{/repo}",
          followers_url: "https://api.github.com/users/matt-aitken/followers",
          following_url:
            "https://api.github.com/users/matt-aitken/following{/other_user}",
          organizations_url: "https://api.github.com/users/matt-aitken/orgs",
          subscriptions_url:
            "https://api.github.com/users/matt-aitken/subscriptions",
          received_events_url:
            "https://api.github.com/users/matt-aitken/received_events",
        },
        repository: {
          id: 602708245,
          url: "https://api.github.com/repos/ericallam/basic-starter-12k",
          fork: false,
          name: "basic-starter-12k",
          size: 0,
          forks: 0,
          owner: {
            id: 534,
            url: "https://api.github.com/users/ericallam",
            type: "User",
            login: "ericallam",
            node_id: "MDQ6VXNlcjUzNA==",
            html_url: "https://github.com/ericallam",
            gists_url: "https://api.github.com/users/ericallam/gists{/gist_id}",
            repos_url: "https://api.github.com/users/ericallam/repos",
            avatar_url: "https://avatars.githubusercontent.com/u/534?v=4",
            events_url:
              "https://api.github.com/users/ericallam/events{/privacy}",
            site_admin: false,
            gravatar_id: "",
            starred_url:
              "https://api.github.com/users/ericallam/starred{/owner}{/repo}",
            followers_url: "https://api.github.com/users/ericallam/followers",
            following_url:
              "https://api.github.com/users/ericallam/following{/other_user}",
            organizations_url: "https://api.github.com/users/ericallam/orgs",
            subscriptions_url:
              "https://api.github.com/users/ericallam/subscriptions",
            received_events_url:
              "https://api.github.com/users/ericallam/received_events",
          },
          topics: [],
          git_url: "git://github.com/ericallam/basic-starter-12k.git",
          license: null,
          node_id: "R_kgDOI-yZFQ",
          private: false,
          ssh_url: "git@github.com:ericallam/basic-starter-12k.git",
          svn_url: "https://github.com/ericallam/basic-starter-12k",
          archived: false,
          disabled: false,
          has_wiki: true,
          homepage: null,
          html_url: "https://github.com/ericallam/basic-starter-12k",
          keys_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/keys{/key_id}",
          language: null,
          tags_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/tags",
          watchers: 0,
          blobs_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/git/blobs{/sha}",
          clone_url: "https://github.com/ericallam/basic-starter-12k.git",
          forks_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/forks",
          full_name: "ericallam/basic-starter-12k",
          has_pages: false,
          hooks_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/hooks",
          pulls_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/pulls{/number}",
          pushed_at: "2023-02-16T19:25:20Z",
          teams_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/teams",
          trees_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/git/trees{/sha}",
          created_at: "2023-02-16T19:25:19Z",
          events_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/events",
          has_issues: true,
          issues_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues{/number}",
          labels_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/labels{/name}",
          merges_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/merges",
          mirror_url: null,
          updated_at: "2023-02-16T19:25:19Z",
          visibility: "public",
          archive_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/{archive_format}{/ref}",
          commits_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/commits{/sha}",
          compare_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/compare/{base}...{head}",
          description: null,
          forks_count: 0,
          is_template: false,
          open_issues: 21,
          branches_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/branches{/branch}",
          comments_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/comments{/number}",
          contents_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/contents/{+path}",
          git_refs_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/git/refs{/sha}",
          git_tags_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/git/tags{/sha}",
          has_projects: true,
          releases_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/releases{/id}",
          statuses_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/statuses/{sha}",
          allow_forking: true,
          assignees_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/assignees{/user}",
          downloads_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/downloads",
          has_downloads: true,
          languages_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/languages",
          default_branch: "main",
          milestones_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/milestones{/number}",
          stargazers_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/stargazers",
          watchers_count: 0,
          deployments_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/deployments",
          git_commits_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/git/commits{/sha}",
          has_discussions: false,
          subscribers_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/subscribers",
          contributors_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/contributors",
          issue_events_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/events{/number}",
          stargazers_count: 0,
          subscription_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/subscription",
          collaborators_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/collaborators{/collaborator}",
          issue_comment_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/issues/comments{/number}",
          notifications_url:
            "https://api.github.com/repos/ericallam/basic-starter-12k/notifications{?since,all,participating}",
          open_issues_count: 21,
          web_commit_signoff_required: false,
        },
      },
    },
  ],
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

import { client, github, slack } from "@/trigger";
import { Github } from "@trigger.dev/github";
import { events } from "@trigger.dev/github";
import { Job } from "@trigger.dev/sdk";

const githubApiKey = new Github({
  id: "github-api-key",
  token: process.env.GITHUB_API_KEY!,
});

new Job(client, {
  id: "github-integration-on-issue",
  name: "GitHub Integration - On Issue",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onIssue,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-issue-opened",
  name: "GitHub Integration - On Issue Opened",
  version: "0.1.0",
  integrations: { github: githubApiKey },
  trigger: githubApiKey.triggers.repo({
    event: events.onIssueOpened,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.github.addIssueAssignees("add assignee", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
      assignees: ["matt-aitken"],
    });

    await io.github.addIssueLabels("add label", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
      labels: ["bug"],
    });

    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-issue-assigned",
  name: "GitHub Integration - On Issue assigned",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onIssueAssigned,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-issue-commented",
  name: "GitHub Integration - On Issue commented",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onIssueComment,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-star",
  name: "GitHub Integration - On Star",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onStar,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-new-star",
  name: "GitHub Integration - On New Star",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewStar,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-new-repo",
  name: "GitHub Integration - On New Repository",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewRepository,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-new-branch-or-tag",
  name: "GitHub Integration - On New Branch or Tag",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewBranchOrTag,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-new-branch",
  name: "GitHub Integration - On New Branch",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewBranch,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-push",
  name: "GitHub Integration - On Push",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onPush,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-pull-request",
  name: "GitHub Integration - On Pull Request",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onPullRequest,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

new Job(client, {
  id: "github-integration-on-pull-request-review",
  name: "GitHub Integration - On Pull Request Review",
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onPullRequestReview,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    return { payload, ctx };
  },
});

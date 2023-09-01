import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { Github, events } from "@trigger.dev/github";
import { Slack } from "@trigger.dev/slack";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const githubApiKey = new Github({
  id: "github-api-key",
  token: process.env["GITHUB_API_KEY"]!,
});

const github = new Github({
  id: "github",
  octokitRequest: { fetch },
});

const slack = new Slack({ id: "my-slack-new" });

client.defineJob({
  id: "github-create-issue",
  name: "GitHub Integration - Create issue",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "create-issue",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
    }),
  }),
  integrations: {
    github: githubApiKey,
  },
  run: async (payload, io, ctx) => {
    const issue = await io.github.createIssue("create issue", {
      title: payload.title,
      owner: payload.owner,
      repo: payload.repo,
    });

    await io.github.createIssueCommentWithReaction("comment on issue with reaction", {
      body: "This is a comment",
      owner: payload.owner,
      repo: payload.repo,
      issueNumber: issue.number,
      reaction: "heart",
    });
  },
});

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
  id: "star-slack-notification",
  name: "New Star Slack Notification",
  version: "0.1.0",
  integrations: { slack },
  trigger: githubApiKey.triggers.repo({
    event: events.onNewStar,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    const response = await io.slack.postMessage("Slack star", {
      text: `${payload.sender.login} starred ${payload.repository.full_name}.\nTotal: ${payload.repository.stargazers_count}⭐️`,
      channel: "C04GWUTDC3W",
    });
  },
});

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
  id: "github-integration-on-pull-request-merge-commit",
  name: "GitHub Integration - on Pull Request Merge Commit",
  version: "0.1.0",
  integrations: { github },
  trigger: githubApiKey.triggers.repo({
    event: events.onPullRequest,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");

    if (payload.pull_request.merged && payload.pull_request.merge_commit_sha) {
      const commit = await io.github.getCommit("get merge commit", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        commitSHA: payload.pull_request.merge_commit_sha,
      });
      await io.logger.info("Merge Commit Details", commit);
    }

    return { payload, ctx };
  },
});

client.defineJob({
  id: "github-integration-get-tree",
  name: "GitHub Integration - Get Tree",
  version: "0.1.0",
  integrations: { github },
  trigger: githubApiKey.triggers.repo({
    event: events.onPullRequest,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");

    if (payload.pull_request.merged && payload.pull_request.merge_commit_sha) {
      const tree = await io.github.getTree("get merge commit", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        treeSHA: payload.pull_request.merge_commit_sha,
      });
      await io.logger.info("Tree ", tree);
    }

    return { payload, ctx };
  },
});

client.defineJob({
  id: "github-integration-get-reference",
  name: "GitHub Integration - Get Reference",
  integrations: { github },
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewBranch,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");

    const ref = await io.github.getReference("Get reference", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: payload.ref,
    });

    await io.logger.info("Reference ", ref);

    return { payload, ctx };
  },
});

client.defineJob({
  id: "github-integration-list-matching-references",
  name: "GitHub Integration - List Matching References",
  integrations: { github },
  version: "0.1.0",
  trigger: githubApiKey.triggers.repo({
    event: events.onNewBranch,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");

    const ref = await io.github.listMatchingReferences("List Matching References", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: payload.ref,
    });

    await io.logger.info("Reference ", ref);

    return { payload, ctx };
  },
});

client.defineJob({
  id: "github-integration-get-tag",
  name: "GitHub Integration - Get Tag",
  version: "0.1.0",
  integrations: { github },
  trigger: githubApiKey.triggers.repo({
    event: events.onNewBranchOrTag,
    owner: "triggerdotdev",
    repo: "empty",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a simple log info message");
    if (payload.ref_type === "tag") {
      const tag = io.github.getTag("Get Tag", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        tagSHA: payload.ref,
      });
      await io.logger.info("Tag ", tag);
    }
    return { payload, ctx };
  },
});

createExpressServer(client);

import { Trigger } from "@trigger.dev/sdk";
import { events } from "@trigger.dev/github";

new Trigger({
  id: "github-webhook-9",
  name: "GitHub issue: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.issueEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-issue-comment",
  name: "GitHub issue comment: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.issueCommentEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-pull_request",
  name: "GitHub PR: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.pullRequestEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-pull_request_comment",
  name: "GitHub PR review comment: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.pullRequestCommentEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-pull_request_review",
  name: "GitHub PR review: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.pullRequestReviewEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-push",
  name: "GitHub push: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.pushEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Push with commits`, event.commits);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-commit_comment",
  name: "GitHub commit comment: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.commitCommentEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Push with action ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-new-star",
  name: "GitHub New Star: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.newStarEvent({
    repo: "triggerdotdev/hello-world",
  }),
  run: async (event, ctx) => {
    return {};
  },
}).listen();

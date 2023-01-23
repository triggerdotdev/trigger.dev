import { Trigger } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/integrations";

new Trigger({
  id: "github-webhook-9",
  name: "GitHub issue: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: github.events.issueEvent({
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
  on: github.events.pullRequestEvent({
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
  on: github.events.pullRequestCommentEvent({
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
  on: github.events.pullRequestReviewEvent({
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
  on: github.events.pushEvent({
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
  on: github.events.commitCommentEvent({
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
  on: github.events.newStarEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    return {};
  },
}).listen();

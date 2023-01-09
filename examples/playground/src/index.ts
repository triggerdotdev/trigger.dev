import { Trigger, customEvent } from "@trigger.dev/sdk";
import { github, slack } from "@trigger.dev/integrations";
import { z } from "zod";

new Trigger({
  id: "playground",
  name: "Trigger.dev Playground",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  on: customEvent({
    name: "playground",
    schema: z.object({
      id: z.string(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(
      "Hey there! This is the Trigger.dev Playground. You can use this to test your Trigger.dev code."
    );

    await ctx.waitFor("initial-wait", { minutes: 1 });

    await ctx.logger.error("Error message!", { event });

    await ctx.logger.info("Info message");

    const response = await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is a test message from the Trigger.dev Playground ${event.id}`,
    });

    await ctx.logger.debug("Debug message");

    await ctx.logger.warn("Warning message!");

    return response.message;
  },
}).listen();

new Trigger({
  id: "playground-2",
  name: "Playground 2",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  on: github.triggers.repoIssueEvent({ repo: "triggerdotdev/trigger.dev" }),

  run: async (event, ctx) => {
    await ctx.logger.info(
      "Hey there! This is the Trigger.dev Playground. You can use this to test your Trigger.dev code."
    );

    await ctx.waitFor("initial-wait", { seconds: 30 });

    await ctx.waitUntil("wait-until", new Date(Date.now() + 1000 * 30));

    await ctx.logger.error("Error message!", { event });

    await ctx.logger.info("Info message");

    const response = await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is a test message from the Trigger.dev Playground ${event.action}`,
    });

    await ctx.logger.debug("Debug message");

    await ctx.logger.warn("Warning message!");

    return response.message;
  },
}).listen();

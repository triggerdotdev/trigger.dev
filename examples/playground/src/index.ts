import { Trigger, customEvent } from "@trigger.dev/sdk";
import { github, slack } from "@trigger.dev/integrations";
import { z } from "zod";

new Trigger({
  id: "playground-1",
  name: "Playground 1",
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

    await ctx.waitFor("initial-wait", { seconds: 10 });

    await ctx.logger.error("Error message!", { event });

    await ctx.logger.info("Info message", { event });

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
  on: github.events.repoIssueEvent({ repo: "triggerdotdev/trigger.dev" }),

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

new Trigger({
  id: "playground-3",
  name: "Playground 3",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  on: github.events.repoIssueEvent({ repo: "triggerdotdev/trigger.dev" }),

  run: async (event, ctx) => {
    await ctx.logger.info(
      "Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it."
    );

    await ctx.waitFor("initial-wait", { seconds: 30 });

    await ctx.logger.error(
      "This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message!",
      { event }
    );

    await ctx.waitUntil("wait-until", new Date(Date.now() + 1000 * 10));

    await ctx.logger.info("Info message");

    const response = await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is test message 1/2 from the Trigger.dev Playground 3 ${event.action}`,
    });

    await ctx.logger.debug("Debug message");

    await ctx.logger.warn("Warning message!");

    await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is test message 2/2 from the Trigger.dev Playground 3 ${event.action}`,
    });

    return response.message;
  },
}).listen();

new Trigger({
  id: "playground-4",
  name: "Playground 4",
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
      "Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it."
    );

    await ctx.waitFor("initial-wait", { seconds: 10 });

    await ctx.logger.error("Error message!", { event });

    await ctx.logger.info("Info message", { event });

    await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is test message 1/2 from the Trigger.dev Playground 4 ${event.id}`,
    });

    await ctx.logger.debug("Debug message");

    await ctx.waitFor("second-wait", { seconds: 10 });

    await ctx.logger.warn("Warning message!");

    const response = await slack.postMessage("send-to-slack", {
      channel: "test-integrations",
      text: `This is test message 2/2 from the Trigger.dev Playground 4 ${event.id}`,
    });

    return response.message;
  },
}).listen();

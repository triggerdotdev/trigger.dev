import { Trigger, customEvent } from "@trigger.dev/sdk";
import { github, slack } from "@trigger.dev/integrations";
import { z } from "zod";

// Workflow that sends a message to Slack

// new Trigger({
//   id: "playground-1",
//   name: "Post to Slack immediately",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow will post a message to Slack immediately and display an Error, Info, Debug, and Warning message."
//     );

//     await ctx.logger.error("Error message!", { event });

//     await ctx.logger.info("Info message", { event });

//     await ctx.logger.debug("Debug message");

//     await ctx.logger.warn("Warning message!");

//     const response = await slack.postMessage("send-to-slack", {
//       channel: "test-integrations",
//       text: `This is a message from the "Posts to Slack" workflow ${event.id}`,
//     });

//     return response.message;
//   },
// }).listen();

// // Webhook workflow that sends a message to Slack when a Github issue is created after 2 delays

// new Trigger({
//   id: "playground-2",
//   name: "Posts to Slack after a GitHub Issue created",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: github.events.repoIssueEvent({ repo: "triggerdotdev/trigger.dev" }),

//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow will post to Slack when a GitHub Issue created or modified after 2 delays."
//     );

//     await ctx.waitFor("initial-wait", { seconds: 30 });

//     await ctx.waitUntil("wait-until", new Date(Date.now() + 1000 * 30));

//     await ctx.logger.info("Both types of delay happened");

//     const response = await slack.postMessage("send-to-slack", {
//       channel: "test-integrations",
//       text: `This is a message posts after an Issue was created on GitHub ${event.action}`,
//     });

//     await ctx.logger.debug("Debug message");

//     await ctx.logger.warn("Warning message!");

//     return response.message;
//   },
// }).listen();

// // Workflow that shows all the log types with a 5 second delay between each

// new Trigger({
//   id: "playground-3",
//   name: "All log types with a 5 second delay between each",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),

//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow prints all the log types with a 5 second delay between each."
//     );

//     await ctx.logger.info(
//       "Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it. Hey there! This is a really long message to see how the layout handles it. If this breaks the layout, I will fix it."
//     );

//     await ctx.waitFor("first-wait", { seconds: 5 });

//     await ctx.logger.error(
//       "This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message! This is a really long Error message!",
//       { event }
//     );

//     await ctx.waitFor("second-wait", { seconds: 5 });

//     await ctx.logger.info(
//       "This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message. This is a really long Info message."
//     );

//     await ctx.waitFor("third-wait", { seconds: 5 });

//     await ctx.logger.debug(
//       "This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. This is a really long Debug message. "
//     );

//     await ctx.waitFor("fourth-wait", { seconds: 5 });

//     await ctx.logger.warn(
//       "This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! This is a really long Warning message! "
//     );

//     await ctx.waitFor("fifth-wait", { seconds: 5 });

//     const response = await slack.postMessage("send-to-slack", {
//       channel: "test-integrations",
//       text: `This test displays all the log types in the webapp ${event.id}`,
//     });

//     return response.message;
//   },
// }).listen();

// // Workflow that sends 2 messages to Slack with a 10 second delay between both

// new Trigger({
//   id: "playground-4",
//   name: "Post to Slack twice after 10 second delays",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow sends 2 messages to Slack with a 10 second delay between both."
//     );

//     await ctx.waitFor("initial-wait", { seconds: 10 });

//     await slack.postMessage("send-to-slack-1", {
//       channel: "test-integrations",
//       text: `This is test message 1/2 from "Post to Slack twice after 10 second delays" workflow ${event.id}`,
//     });

//     await ctx.waitFor("second-wait", { seconds: 10 });

//     const response = await slack.postMessage("send-to-slack-2", {
//       channel: "test-integrations",
//       text: `This is test message 2/2 from "Post to Slack twice after 10 second delays" workflow ${event.id}`,
//     });

//     return response.message;
//   },
// }).listen();

// // Workflow that send a message to Slack after 1 hour

// new Trigger({
//   id: "playground-5",
//   name: "Post to Slack after 1 hour",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow posts a message to Slack after a 1 hour delay"
//     );

//     await ctx.waitUntil("wait-until", new Date(Date.now() + 1000 * 60 * 60));

//     await ctx.logger.info("The workflow resumed after the 1 hour delay", {
//       event,
//     });

//     const response = await slack.postMessage("send-to-slack", {
//       channel: "test-integrations",
//       text: `This message was sent after a 1 hour delay ${event.id}`,
//     });

//     return response.message;
//   },
// }).listen();

// // Workflow that send a message to Slack after 24 hours

// new Trigger({
//   id: "playground-6",
//   name: "Post to Slack after a 24 hour delay",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info(
//       "This workflow posts a message to Slack after a 24 hour delay"
//     );

//     await ctx.waitUntil(
//       "wait-until",
//       new Date(Date.now() + 1000 * 60 * 60 * 24)
//     );

//     await ctx.logger.info("The workflow resumed after the 24 hour delay", {
//       event,
//     });

//     const response = await slack.postMessage("send-to-slack", {
//       channel: "test-integrations",
//       text: `This message was sent after a 24 hour delay ${event.id}`,
//     });

//     return response.message;
//   },
// }).listen();

// // Workflow that send a message to Slack after 24 hours

// new Trigger({
//   id: "playground-7",
//   name: "Post to Slack many times in a loop",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   on: customEvent({
//     name: "playground",
//     schema: z.object({
//       id: z.string(),
//     }),
//   }),
//   run: async (event, ctx) => {
//     for (let index = 0; index < 4; index++) {
//       const response = await slack.postMessage(`send-to-slack-${index}`, {
//         channel: "test-integrations",
//         text: `This is a post to Slack many times in a loop ${index} ${event.id}`,
//       });
//     }

//     return {};
//   },
// }).listen();

const postMessage = new Trigger({
  id: "new-user",
  name: "New user slack message",
  apiKey: "trigger_development_lwlXEjyhSNF4",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "info",
  on: customEvent({
    name: "user.created",
    schema: z.object({
      name: z.string(),
      email: z.string(),
      paidPlan: z.boolean(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("This log will appear on the Trigger.dev run page");

    //send a message to the #new-users Slack channel with user details
    const response = await slack.postMessage("send-to-slack", {
      channel: "new-users",
      text: `New user: ${event.name} (${event.email}) signed up. ${
        event.paidPlan ? "They are paying" : "They are on the free plan"
      }.`,
    });

    return response.message;
  },
});

//this workflow will now connect and start listening for events
postMessage.listen();

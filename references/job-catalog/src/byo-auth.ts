import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Resend } from "@trigger.dev/resend";
import { Stripe } from "@trigger.dev/stripe";
import { Slack } from "@trigger.dev/slack";
import { OpenAI } from "@trigger.dev/openai";
import { Clerk } from "@clerk/backend";

const clerk = Clerk({ apiKey: process.env.CLERK_API_KEY });

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const resend = new Resend({ id: "resend" });
const stripe = new Stripe({
  id: "stripe",
});
const slack = new Slack({ id: "slack" });
const openai = new OpenAI({ id: "openai" });

client.defineAuthResolver(resend, async (ctx, integration) => {
  return {
    type: "apiKey",
    token: process.env.RESEND_API_KEY!,
    additionalFields: {
      baseUrl: "bar",
    },
  };
});

client.defineAuthResolver(stripe, async (ctx, integration) => {
  return {
    type: "apiKey",
    token: process.env.STRIPE_API_KEY!,
  };
});

client.defineAuthResolver(slack, async (ctx, integration) => {
  if (!ctx.account?.id) {
    return;
  }

  const tokens = await clerk.users.getUserOauthAccessToken(ctx.account.id, "oauth_slack");

  if (tokens.length === 0) {
    throw new Error(`Could not find Slack auth for account ${ctx.account.id}`);
  }

  return {
    type: "oauth",
    token: tokens[0].token,
  };
});

client.defineAuthResolver(openai, async (ctx, integration) => {
  return {
    type: "apiKey",
    token: process.env.OPENAI_API_KEY!,
  };
});

client.defineJob({
  id: "send-account-event",
  name: "Send Account Event",
  version: "1.0.0",
  enabled: true,
  trigger: eventTrigger({
    name: "foo.bar",
  }),
  integrations: {
    resend,
    stripe,
    slack,
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.logger.info("Sending email with context", { ctx });

    await io.slack.postMessage("💬", {
      channel: "C04GWUTDC3W",
      text: "This is from an auth resolver",
    });

    await io.stripe.subscriptions.retrieve("🤑", { id: "1234" });

    await io.resend.sendEmail("📧", {
      subject: "Hello there",
      text: "This is an email",
      to: "eric@trigger.dev",
      from: "hi@email.trigger.dev",
    });
  },
});

const dynamicInterval = client.defineDynamicSchedule({ id: "dynamic-schedule" });

client.defineJob({
  id: "register-interval",
  name: "Register Interval for Account",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "register.interval",
  }),
  run: async (payload, io, ctx) => {
    await slack.postMessage("🤖", {
      text: "asdas",
      channel: "Asdas",
    });

    await dynamicInterval.register("schedule_123", {
      type: "interval",
      options: { seconds: 3600 }, // runs every hour
      accountId: "user_123", // associate runs triggered by this schedule with user_123
    });
  },
});

createExpressServer(client);

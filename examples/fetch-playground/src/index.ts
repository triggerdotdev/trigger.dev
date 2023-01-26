import { slack } from "@trigger.dev/integrations";
import { Trigger, customEvent, webhookEvent } from "@trigger.dev/sdk";

import { z } from "zod";

new Trigger({
  id: "fetch-playground",
  name: "Fetch Playground",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "playground.fetch",
    schema: z.object({
      url: z.string().default("http://localhost:8888"),
      path: z.string().default("/"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
        .default("GET"),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
      retry: z
        .object({
          enabled: z.boolean().default(true),
          maxAttempts: z.number().default(3),
          minTimeout: z.number().default(1000),
          maxTimeout: z.number().default(60000),
          factor: z.number().default(1.8),
          statusCodes: z
            .array(z.number())
            .default([408, 429, 500, 502, 503, 504]),
        })
        .optional(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Received the playground.fetch event", {
      event,
      wallTime: new Date(),
    });

    if (ctx.isTest) {
      await ctx.logger.warn("This is only a test");
    }

    const response = await ctx.fetch("do-fetch", `${event.url}${event.path}`, {
      method: event.method,
      responseSchema: z.any(),
      headers: event.headers,
      body: event.body ? JSON.stringify(event.body) : undefined,
      retry: event.retry,
    });

    await ctx.logger.info("Received the fetch response", {
      response,
      wallTime: new Date(),
    });
  },
}).listen();

export const bookingPayloadSchema = z.object({
  triggerEvent: z.string(),
  createdAt: z.coerce.date(),
  payload: z.object({
    type: z.string(),
    title: z.string(),
    description: z.string(),
    additionalNotes: z.string(),
    customInputs: z.object({}),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    organizer: z.object({
      id: z.number(),
      name: z.string(),
      email: z.string(),
      timeZone: z.string(),
      language: z.object({ locale: z.string() }),
    }),
    attendees: z.array(
      z.object({
        email: z.string(),
        name: z.string(),
        timeZone: z.string(),
        language: z.object({ locale: z.string() }),
      })
    ),
    location: z.string(),
    destinationCalendar: z.object({
      id: z.number(),
      integration: z.string(),
      externalId: z.string(),
      userId: z.number(),
      eventTypeId: z.null(),
      credentialId: z.number(),
    }),
    hideCalendarNotes: z.boolean(),
    requiresConfirmation: z.null(),
    eventTypeId: z.number(),
    seatsShowAttendees: z.boolean(),
    uid: z.string(),
    conferenceData: z.object({
      createRequest: z.object({ requestId: z.string() }),
    }),
    videoCallData: z.object({
      type: z.string(),
      id: z.string(),
      password: z.string(),
      url: z.string(),
    }),
    appsStatus: z.array(
      z.object({
        appName: z.string(),
        type: z.string(),
        success: z.number(),
        failures: z.number(),
        errors: z.array(z.any()).optional(),
        warnings: z.array(z.any()).optional(),
      })
    ),
    eventTitle: z.string(),
    eventDescription: z.null(),
    price: z.number(),
    currency: z.string(),
    length: z.number(),
    bookingId: z.number(),
    metadata: z.object({ videoCallUrl: z.string() }),
    status: z.string(),
  }),
});

new Trigger({
  id: "caldotcom-to-slack-2",
  name: "Cal.com To Slack",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: webhookEvent({
    service: "cal.com",
    eventName: "BOOKING_CREATED",
    filter: {
      triggerEvent: ["BOOKING_CREATED"],
    },
    schema: bookingPayloadSchema,
    verifyPayload: {
      enabled: true,
      header: "X-Cal-Signature-256",
    },
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Received a cal.com booking", {
      event,
      wallTime: new Date(),
    });

    await slack.postMessage(`Cal.com booking yo`, {
      channelName: "customers",
      text: `New Booking: ${
        event.payload.title
      } at ${event.payload.startTime.toLocaleDateString()}`,
    });
  },
}).listen();

new Trigger({
  id: "site-check",
  name: "Site Check",
  on: customEvent({
    name: "site.check",
    schema: z.object({ url: z.string().url() }),
  }),
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  triggerTTL: 60,
  run: async (event, context) => {
    const response = await context.fetch("do-fetch", event.url, {
      method: "GET",
      retry: {
        enabled: false,
      },
    });

    if (response.ok) {
      await context.logger.info(`${event.url} is up!`);
      return;
    }

    await slack.postMessage("Site is down", {
      channelName: "monitoring",
      text: `${event.url} is down: ${response.status}`,
    });
  },
}).listen();

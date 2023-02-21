import * as slack from "@trigger.dev/slack";
import { Trigger, webhookEvent } from "@trigger.dev/sdk";
import { z } from "zod";

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
  apiKey: "trigger_development_lwlXEjyhSNF4",
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

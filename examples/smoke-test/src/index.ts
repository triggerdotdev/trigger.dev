import { z } from "zod";
import {
  Trigger,
  customEvent,
  sendEvent,
  scheduleEvent,
  webhookEvent,
} from "@trigger.dev/sdk";
import { ulid } from "ulid";

const userCreatedEvent = z.object({
  id: z.string(),
});

new Trigger({
  id: "my-workflow",
  name: "My workflow",
  apiKey: "trigger_development_cMYVGTvv3gyx",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  triggerTTL: 60 * 60 * 24,
  on: customEvent({ name: "user.created", schema: userCreatedEvent }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    await ctx.sendEvent("start-fire", {
      name: "smoke.test",
      payload: { baz: "banana" },
      delay: { until: new Date(Date.now() + 1000 * 60) },
    });

    await sendEvent("start-fire-2", {
      name: "smoke.test2",
      payload: { baz: "banana2" },
      delay: { minutes: 1 },
    });

    return { foo: "bar" };
  },
}).listen();

new Trigger({
  id: "my-other-workflow",
  name: "My other workflow",
  apiKey: "trigger_development_cMYVGTvv3gyx",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  triggerTTL: 60 * 60 * 24,
  on: customEvent({ name: "smoke.test2" }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test 2 workflow, received event", {
      event,
      myDate: new Date(),
    });
  },
}).listen();

new Trigger({
  id: "my-scheduled-workflow",
  name: "My scheduled workflow",
  apiKey: "trigger_development_cMYVGTvv3gyx",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  triggerTTL: 60 * 60 * 24,
  on: scheduleEvent({
    rateOf: { minutes: 1 },
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test 2 workflow, received event", {
      event,
      myDate: new Date(),
    });
  },
}).listen();

// new Trigger({
//   id: "smoke-test",
//   name: "Smoke Test",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   logLevel: "debug",
//   on: customEvent({
//     name: "smoke.test",
//     schema: z.object({ baz: z.string() }),
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info("Inside the smoke test workflow, received event", {
//       event,
//       myDate: new Date(),
//     });
//   },
// }).listen();

// new Trigger({
//   id: "log-tests",
//   name: "My logs",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   logLevel: "debug",
//   on: customEvent({ name: "user.created", schema: z.any() }),
//   run: async (event, ctx) => {
//     await ctx.logger.info("It's been 5 minutes since the last run!");
//     await ctx.logger.debug("This is a debug log");
//     await ctx.logger.warn("This is a warning");
//     await ctx.logger.error("This is an error");
//   },
// }).listen();

// export const bookingPayloadSchema = z.object({
//   triggerEvent: z.string(),
//   createdAt: z.coerce.date(),
//   payload: z.object({
//     type: z.string(),
//     title: z.string(),
//     description: z.string(),
//     additionalNotes: z.string(),
//     customInputs: z.object({}),
//     startTime: z.coerce.date(),
//     endTime: z.coerce.date(),
//     organizer: z.object({
//       id: z.number(),
//       name: z.string(),
//       email: z.string(),
//       timeZone: z.string(),
//       language: z.object({ locale: z.string() }),
//     }),
//     attendees: z.array(
//       z.object({
//         email: z.string(),
//         name: z.string(),
//         timeZone: z.string(),
//         language: z.object({ locale: z.string() }),
//       })
//     ),
//     location: z.string(),
//     destinationCalendar: z.object({
//       id: z.number(),
//       integration: z.string(),
//       externalId: z.string(),
//       userId: z.number(),
//       eventTypeId: z.null(),
//       credentialId: z.number(),
//     }),
//     hideCalendarNotes: z.boolean(),
//     requiresConfirmation: z.null(),
//     eventTypeId: z.number(),
//     seatsShowAttendees: z.boolean(),
//     uid: z.string(),
//     conferenceData: z.object({
//       createRequest: z.object({ requestId: z.string() }),
//     }),
//     videoCallData: z.object({
//       type: z.string(),
//       id: z.string(),
//       password: z.string(),
//       url: z.string(),
//     }),
//     appsStatus: z.array(
//       z.object({
//         appName: z.string(),
//         type: z.string(),
//         success: z.number(),
//         failures: z.number(),
//         errors: z.array(z.any()).optional(),
//         warnings: z.array(z.any()).optional(),
//       })
//     ),
//     eventTitle: z.string(),
//     eventDescription: z.null(),
//     price: z.number(),
//     currency: z.string(),
//     length: z.number(),
//     bookingId: z.number(),
//     metadata: z.object({ videoCallUrl: z.string() }),
//     status: z.string(),
//   }),
// });

// new Trigger({
//   id: "calcom-booking-custom-event",
//   name: "Cal.com booking custom event",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   logLevel: "debug",
//   triggerTTL: 60 * 60 * 24,
//   on: customEvent({ name: "calcom.booking", schema: bookingPayloadSchema }),
//   run: async (event, ctx) => {
//     return event;
//   },
// }).listen();

// new Trigger({
//   id: "testing-schedule-test-events",
//   name: "Testing scheduled test payloads",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   logLevel: "debug",
//   triggerTTL: 60 * 60 * 24,
//   on: scheduleEvent({
//     rateOf: { hours: 1 },
//   }),
//   run: async (event, ctx) => {
//     return event;
//   },
// }).listen();

// new Trigger({
//   id: "smoke-test-webhook-schema-test",
//   name: "Smoke Test Webhook Schema Test",
//   apiKey: "trigger_dev_zC25mKNn6c0q",
//   endpoint: "ws://localhost:8889/ws",
//   logLevel: "debug",
//   on: webhookEvent({
//     service: "cal.com",
//     eventName: "BOOKING_CREATED",
//     filter: {
//       triggerEvent: ["BOOKING_CREATED"],
//     },
//     schema: bookingPayloadSchema,
//     verifyPayload: {
//       enabled: true,
//       header: "X-Cal-Signature-256",
//     },
//   }),
//   run: async (event, ctx) => {
//     await ctx.logger.info("Received a cal.com booking", {
//       event,
//       wallTime: new Date(),
//     });
//   },
// }).listen();

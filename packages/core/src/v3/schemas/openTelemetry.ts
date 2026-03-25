import { z } from "zod";

export const ExceptionEventProperties = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  stacktrace: z.string().optional(),
});

export type ExceptionEventProperties = z.infer<typeof ExceptionEventProperties>;

export const ExceptionSpanEvent = z.object({
  name: z.literal("exception"),
  time: z.coerce.date(),
  properties: z.object({
    exception: ExceptionEventProperties,
  }),
});

export type ExceptionSpanEvent = z.infer<typeof ExceptionSpanEvent>;

export const CancellationSpanEvent = z.object({
  name: z.literal("cancellation"),
  time: z.coerce.date(),
  properties: z.object({
    reason: z.string(),
  }),
});

export type CancellationSpanEvent = z.infer<typeof CancellationSpanEvent>;

export const AttemptFailedSpanEvent = z.object({
  name: z.literal("attempt_failed"),
  time: z.coerce.date(),
  properties: z.object({
    exception: ExceptionEventProperties,
    attemptNumber: z.number(),
    runId: z.string(),
  }),
});

export type AttemptFailedSpanEvent = z.infer<typeof AttemptFailedSpanEvent>;

export const OtherSpanEvent = z.object({
  name: z.string(),
  time: z.coerce.date(),
  properties: z.record(z.unknown()),
});

export type OtherSpanEvent = z.infer<typeof OtherSpanEvent>;

export const SpanEvent = z.union([
  ExceptionSpanEvent,
  CancellationSpanEvent,
  AttemptFailedSpanEvent,
  OtherSpanEvent,
]);

export type SpanEvent = z.infer<typeof SpanEvent>;

export const SpanEvents = z.array(SpanEvent);

export type SpanEvents = z.infer<typeof SpanEvents>;

export function isExceptionSpanEvent(event: SpanEvent): event is ExceptionSpanEvent {
  return event.name === "exception";
}

export function isCancellationSpanEvent(event: SpanEvent): event is CancellationSpanEvent {
  return event.name === "cancellation";
}

export function isAttemptFailedSpanEvent(event: SpanEvent): event is AttemptFailedSpanEvent {
  return event.name === "attempt_failed";
}

export const SpanMessagingEvent = z.object({
  system: z.string().optional(),
  client_id: z.string().optional(),
  operation: z.enum(["publish", "create", "receive", "deliver"]),
  message: z.any(),
  destination: z.string().optional(),
});

export type SpanMessagingEvent = z.infer<typeof SpanMessagingEvent>;

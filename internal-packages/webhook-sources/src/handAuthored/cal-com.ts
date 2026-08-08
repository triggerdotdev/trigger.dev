import { type SampleRecord } from "../sampleRecord.js";

/**
 * Cal.com samples. No preset: Cal.com signs with its own `x-cal-signature-256` header, a plain hex
 * HMAC-SHA256 digest of the raw body (no `sha256=` prefix), which does not match our `github`
 * preset's wire format. `MEETING_ENDED` is an exception among these events: its fields sit flat at
 * the top level instead of nested under `payload`.
 */
export const samples: SampleRecord[] = [
  {
    provider: "cal-com",
    providerLabel: "Cal.com",
    eventType: "BOOKING_CREATED",
    name: "Booking created",
    description: "A new booking was made for an event type and accepted immediately.",
    body: {
      triggerEvent: "BOOKING_CREATED",
      createdAt: "2026-07-01T14:05:00.000Z",
      payload: {
        bookerUrl: "https://cal.com/jordan-lee",
        title: "30 Min Meeting between Jordan Lee and Priya Nair",
        startTime: "2026-07-03T16:00:00.000Z",
        endTime: "2026-07-03T16:30:00.000Z",
        eventTypeId: 48213,
        organizer: {
          id: 9021,
          name: "Jordan Lee",
          email: "jordan.lee@example.com",
          username: "jordan-lee",
          timeZone: "America/Los_Angeles",
          timeFormat: "h:mma",
        },
        attendees: [
          {
            email: "priya.nair@example.com",
            name: "Priya Nair",
            timeZone: "Asia/Kolkata",
          },
        ],
        location: "https://meet.google.com/abc-defg-hij",
        uid: "8f2b6c1a9d3e4a7fb5c21e6f9a0d4b7c",
        bookingId: 5502391,
        status: "ACCEPTED",
      },
    },
    docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "cal-com",
    providerLabel: "Cal.com",
    eventType: "BOOKING_CANCELLED",
    name: "Booking cancelled",
    description: "The attendee cancelled an existing booking and gave a reason.",
    body: {
      triggerEvent: "BOOKING_CANCELLED",
      createdAt: "2026-07-02T09:41:12.000Z",
      payload: {
        title: "30 Min Meeting between Jordan Lee and Priya Nair",
        startTime: "2026-07-03T16:00:00.000Z",
        endTime: "2026-07-03T16:30:00.000Z",
        organizer: {
          id: 9021,
          name: "Jordan Lee",
          email: "jordan.lee@example.com",
          username: "jordan-lee",
          timeZone: "America/Los_Angeles",
          timeFormat: "h:mma",
        },
        attendees: [
          {
            email: "priya.nair@example.com",
            name: "Priya Nair",
            timeZone: "Asia/Kolkata",
          },
        ],
        uid: "8f2b6c1a9d3e4a7fb5c21e6f9a0d4b7c",
        bookingId: 5502391,
        cancellationReason: "Something came up, need to reschedule for next week.",
        status: "CANCELLED",
      },
    },
    docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "cal-com",
    providerLabel: "Cal.com",
    eventType: "BOOKING_RESCHEDULED",
    name: "Booking rescheduled",
    description:
      "An existing booking was moved to a new time; the payload links old and new slots.",
    body: {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: "2026-07-04T11:18:47.000Z",
      payload: {
        title: "30 Min Meeting between Jordan Lee and Priya Nair",
        startTime: "2026-07-03T16:00:00.000Z",
        endTime: "2026-07-03T16:30:00.000Z",
        organizer: {
          id: 9021,
          name: "Jordan Lee",
          email: "jordan.lee@example.com",
          username: "jordan-lee",
          timeZone: "America/Los_Angeles",
          timeFormat: "h:mma",
        },
        attendees: [
          {
            email: "priya.nair@example.com",
            name: "Priya Nair",
            timeZone: "Asia/Kolkata",
          },
        ],
        uid: "8f2b6c1a9d3e4a7fb5c21e6f9a0d4b7c",
        bookingId: 5502391,
        rescheduleId: 5502391,
        rescheduleUid: "3f6a1c2e71b44b8d9e2a6d4f0a8b1c3d",
        rescheduleStartTime: "2026-07-10T17:00:00.000Z",
        rescheduleEndTime: "2026-07-10T17:30:00.000Z",
        status: "ACCEPTED",
      },
    },
    docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "cal-com",
    providerLabel: "Cal.com",
    eventType: "MEETING_ENDED",
    name: "Meeting ended",
    description:
      "A booked meeting finished. Unlike the other trigger events, MEETING_ENDED carries its fields flat at the top level instead of under payload.",
    body: {
      triggerEvent: "MEETING_ENDED",
      id: 5502391,
      uid: "8f2b6c1a9d3e4a7fb5c21e6f9a0d4b7c",
      userId: 9021,
      eventTypeId: 48213,
      title: "30 Min Meeting between Jordan Lee and Priya Nair",
      startTime: "2026-07-03T16:00:00.000Z",
      endTime: "2026-07-03T16:30:00.000Z",
      createdAt: "2026-07-01T14:05:00.000Z",
      updatedAt: "2026-07-03T16:30:05.000Z",
      status: "ACCEPTED",
      user: {
        email: "jordan.lee@example.com",
        name: "Jordan Lee",
        timeZone: "America/Los_Angeles",
      },
      attendees: [
        {
          id: 771034,
          email: "priya.nair@example.com",
          name: "Priya Nair",
          timeZone: "Asia/Kolkata",
        },
      ],
    },
    docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];

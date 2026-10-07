import { describe, expect, it } from "vitest";
import { getTraceInsertedAtEnd } from "~/v3/eventRepository/traceInsertedAtBound";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED_AT = new Date("2026-05-13T20:13:30.310Z");
const UPDATED_AT = new Date("2026-05-14T09:00:00.000Z");

describe("getTraceInsertedAtEnd", () => {
  it("bounds a completed run at completedAt + 7 days", () => {
    const end = getTraceInsertedAtEnd({
      status: "COMPLETED_WITH_ERRORS",
      completedAt: COMPLETED_AT,
      updatedAt: UPDATED_AT,
    });

    expect(end).toEqual(new Date(COMPLETED_AT.getTime() + 7 * DAY_MS));
  });

  it("falls back to updatedAt + 7 days for a final run with no completedAt", () => {
    const end = getTraceInsertedAtEnd({
      status: "CANCELED",
      completedAt: null,
      updatedAt: UPDATED_AT,
    });

    expect(end).toEqual(new Date(UPDATED_AT.getTime() + 7 * DAY_MS));
  });

  it("does not bound a run that is not in a final status", () => {
    const end = getTraceInsertedAtEnd({
      status: "EXECUTING",
      completedAt: null,
      updatedAt: UPDATED_AT,
    });

    expect(end).toBeUndefined();
  });

  it("does not bound a non-final run even if completedAt is set", () => {
    const end = getTraceInsertedAtEnd({
      status: "WAITING_TO_RESUME",
      completedAt: COMPLETED_AT,
      updatedAt: UPDATED_AT,
    });

    expect(end).toBeUndefined();
  });
});

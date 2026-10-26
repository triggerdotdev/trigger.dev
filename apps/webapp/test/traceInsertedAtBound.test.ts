import { describe, expect, it } from "vitest";
import {
  getRunFinishedAt,
  getTraceInsertedAtEnd,
  getTraceStartTimeEnd,
} from "~/v3/eventRepository/traceInsertedAtBound";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
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

describe("getRunFinishedAt", () => {
  it("returns completedAt for a completed run", () => {
    expect(
      getRunFinishedAt({
        status: "COMPLETED_SUCCESSFULLY",
        completedAt: COMPLETED_AT,
        updatedAt: UPDATED_AT,
      })
    ).toEqual(COMPLETED_AT);
  });

  it("falls back to updatedAt for a CANCELED run with no completedAt", () => {
    expect(
      getRunFinishedAt({ status: "CANCELED", completedAt: null, updatedAt: UPDATED_AT })
    ).toEqual(UPDATED_AT);
  });

  it("keeps completedAt for a non-final run that has one, as before", () => {
    expect(
      getRunFinishedAt({
        status: "WAITING_TO_RESUME",
        completedAt: COMPLETED_AT,
        updatedAt: UPDATED_AT,
      })
    ).toEqual(COMPLETED_AT);
  });

  it("returns undefined for a non-final run", () => {
    expect(
      getRunFinishedAt({ status: "EXECUTING", completedAt: null, updatedAt: UPDATED_AT })
    ).toBeUndefined();
  });
});

describe("getTraceStartTimeEnd", () => {
  it("ends at completedAt when it is set", () => {
    expect(
      getTraceStartTimeEnd({
        status: "COMPLETED_SUCCESSFULLY",
        completedAt: COMPLETED_AT,
        updatedAt: UPDATED_AT,
      })
    ).toEqual(COMPLETED_AT);
  });

  it("keeps completedAt for a non-final run that has one, as before", () => {
    expect(
      getTraceStartTimeEnd({
        status: "WAITING_TO_RESUME",
        completedAt: COMPLETED_AT,
        updatedAt: UPDATED_AT,
      })
    ).toEqual(COMPLETED_AT);
  });

  it("ends 10 minutes after updatedAt for a CANCELED run with no completedAt", () => {
    expect(
      getTraceStartTimeEnd({ status: "CANCELED", completedAt: null, updatedAt: UPDATED_AT })
    ).toEqual(new Date(UPDATED_AT.getTime() + 10 * MINUTE_MS));
  });

  it("does not bound a non-final run with no completedAt", () => {
    expect(
      getTraceStartTimeEnd({ status: "EXECUTING", completedAt: null, updatedAt: UPDATED_AT })
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test", NODE_ENV: "test" } }));

import {
  DEFAULT_SESSION_DURATION_SECONDS,
  sessionEndReason,
  sessionWindowEnd,
} from "../app/services/sessionDuration.server";

const issuedAt = 1_800_000_000_000;
const oneHourMs = 60 * 60 * 1000;
const lifetimeMs = DEFAULT_SESSION_DURATION_SECONDS * 1000;
const noRevocations = { sessionsValidAfter: null, revokedSessions: [] };

describe("sessionWindowEnd", () => {
  it("uses the stamped expiry", () => {
    expect(sessionWindowEnd({ issuedAt, expiresAt: issuedAt + oneHourMs })).toBe(
      issuedAt + oneHourMs
    );
  });

  it("falls back to one cookie lifetime after issue", () => {
    expect(sessionWindowEnd({ issuedAt })).toBe(issuedAt + lifetimeMs);
  });

  it("has no window for a session without an issue time", () => {
    expect(sessionWindowEnd({})).toBeUndefined();
  });
});

describe("sessionEndReason", () => {
  it("keeps a session inside its window", () => {
    const times = { issuedAt, expiresAt: issuedAt + oneHourMs };
    expect(sessionEndReason(noRevocations, times, issuedAt + oneHourMs)).toBeUndefined();
  });

  it("ends a session past its own window", () => {
    const times = { issuedAt, expiresAt: issuedAt + oneHourMs };
    expect(sessionEndReason(noRevocations, times, issuedAt + oneHourMs + 1)).toBe("expired");
    expect(sessionEndReason(noRevocations, { issuedAt }, issuedAt + lifetimeMs + 1)).toBe(
      "expired"
    );
  });

  it("keeps a session without an issue time when nothing was revoked", () => {
    expect(sessionEndReason(noRevocations, {}, issuedAt)).toBeUndefined();
  });

  it("ends only the signed-out session", () => {
    const state = { sessionsValidAfter: null, revokedSessions: [new Date(issuedAt)] };
    expect(sessionEndReason(state, { issuedAt }, issuedAt + 1)).toBe("revoked");
    expect(sessionEndReason(state, { issuedAt: issuedAt + 1 }, issuedAt + 2)).toBeUndefined();
    expect(sessionEndReason(state, {}, issuedAt + 2)).toBeUndefined();
  });

  it("ends sessions issued before the cut-off and keeps the rest", () => {
    const state = { sessionsValidAfter: new Date(issuedAt), revokedSessions: [] };
    expect(sessionEndReason(state, { issuedAt: issuedAt - 1 }, issuedAt)).toBe("revoked");
    expect(sessionEndReason(state, { issuedAt }, issuedAt)).toBeUndefined();
    expect(sessionEndReason(state, { issuedAt: issuedAt + 1 }, issuedAt + 1)).toBeUndefined();
  });

  it("counts a session without an issue time as issued before any cut-off", () => {
    const state = { sessionsValidAfter: new Date(1), revokedSessions: [] };
    expect(sessionEndReason(state, {}, issuedAt)).toBe("revoked");
    expect(sessionEndReason(state, { issuedAt }, issuedAt)).toBeUndefined();
  });
});

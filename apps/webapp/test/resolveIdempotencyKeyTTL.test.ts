import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";

describe("resolveIdempotencyKeyTTL", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 15) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Catches: a storable ttl resolving to a different expiry, or one past what the database stores
  // coming back as a date instead of like an unparsable one.
  it.each([
    ["0s", "2026-01-15T00:00:00.000Z"],
    ["30m", "2026-01-15T00:30:00.000Z"],
    ["12h", "2026-01-15T12:00:00.000Z"],
    ["30d", "2026-02-14T00:00:00.000Z"],
    ["251633865599s", "9999-12-31T23:59:59.000Z"],
    ["251633865600s", undefined],
    ["1234567890d", undefined],
    ["banana", undefined],
    ["", undefined],
    ["10x", undefined],
  ])("resolves %j to %s", (ttl, expected) => {
    expect(resolveIdempotencyKeyTTL(ttl)?.toISOString()).toBe(expected);
  });
});

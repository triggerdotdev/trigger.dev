import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { findFirstMock, updateManyMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  prisma: {
    personalAccessToken: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
    },
  },
  $replica: {},
}));

vi.mock("~/env.server", () => ({
  env: { ENCRYPTION_KEY: "0".repeat(64) },
}));

vi.mock("~/utils/tokens.server", () => ({
  hashToken: (t: string) => `hashed:${t}`,
  encryptToken: () => ({ nonce: "n", ciphertext: "c", tag: "t" }),
  decryptToken: () => "tr_pat_validtoken",
}));

vi.mock("./logger.server", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import {
  authenticatePersonalAccessToken,
  PAT_LAST_ACCESSED_THROTTLE_MS,
} from "~/services/personalAccessToken.server";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("authenticatePersonalAccessToken — lastAccessedAt throttle", () => {
  test("issues a conditional updateMany that skips writes when lastAccessedAt is recent", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "pat_123",
      userId: "user_1",
      hashedToken: "hashed:tr_pat_validtoken",
      encryptedToken: { nonce: "n", ciphertext: "c", tag: "t" },
    });

    const result = await authenticatePersonalAccessToken("tr_pat_validtoken");

    expect(result).toEqual({ userId: "user_1" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);

    const call = updateManyMock.mock.calls[0][0];
    expect(call.where.id).toBe("pat_123");
    expect(call.where.revokedAt).toBeNull();
    expect(call.data.lastAccessedAt).toBeInstanceOf(Date);

    // The WHERE clause should require the existing lastAccessedAt to be null
    // or strictly older than the throttle window — that's the entire point.
    expect(call.where.OR).toEqual([
      { lastAccessedAt: null },
      { lastAccessedAt: { lt: expect.any(Date) } },
    ]);

    // With fake timers, the cutoff lands exactly throttle-ms before "now".
    const cutoff = call.where.OR[1].lastAccessedAt.lt as Date;
    expect(cutoff.getTime()).toBe(Date.now() - PAT_LAST_ACCESSED_THROTTLE_MS);
  });

  test("skips updateMany when token is not found", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const result = await authenticatePersonalAccessToken("tr_pat_validtoken");

    expect(result).toBeUndefined();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  test("skips updateMany when token doesn't start with prefix", async () => {
    const result = await authenticatePersonalAccessToken("not_a_pat");

    expect(result).toBeUndefined();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

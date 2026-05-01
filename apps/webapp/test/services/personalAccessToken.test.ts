import { beforeEach, describe, expect, test, vi } from "vitest";

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
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe("authenticatePersonalAccessToken — lastAccessedAt throttle", () => {
  test("issues a conditional updateMany that skips writes when lastAccessedAt is recent", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "pat_123",
      userId: "user_1",
      hashedToken: "hashed:tr_pat_validtoken",
      encryptedToken: { nonce: "n", ciphertext: "c", tag: "t" },
    });

    const before = Date.now();
    const result = await authenticatePersonalAccessToken("tr_pat_validtoken");
    const after = Date.now();

    expect(result).toEqual({ userId: "user_1" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);

    const call = updateManyMock.mock.calls[0][0];
    expect(call.where.id).toBe("pat_123");
    expect(call.data.lastAccessedAt).toBeInstanceOf(Date);

    // The WHERE clause should require the existing lastAccessedAt to be null
    // or strictly older than the throttle window — that's the entire point.
    expect(call.where.OR).toEqual([
      { lastAccessedAt: null },
      { lastAccessedAt: { lt: expect.any(Date) } },
    ]);

    const cutoff = call.where.OR[1].lastAccessedAt.lt as Date;
    // Cutoff should be exactly throttle-ms before "now" (within the test
    // window). Confirms the throttle constant is wired through correctly.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - PAT_LAST_ACCESSED_THROTTLE_MS - 50);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - PAT_LAST_ACCESSED_THROTTLE_MS + 50);
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

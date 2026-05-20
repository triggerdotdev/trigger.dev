import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { findFirstMock, updateManyMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  prisma: {
    organizationAccessToken: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
    },
  },
  $replica: {},
}));

vi.mock("~/utils/tokens.server", () => ({
  hashToken: (t: string) => `hashed:${t}`,
}));

vi.mock("./logger.server", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import {
  authenticateOrganizationAccessToken,
  OAT_LAST_ACCESSED_THROTTLE_MS,
} from "~/services/organizationAccessToken.server";

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

describe("authenticateOrganizationAccessToken — lastAccessedAt throttle", () => {
  test("issues a conditional updateMany that skips writes when lastAccessedAt is recent", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "oat_123",
      organizationId: "org_1",
      hashedToken: "hashed:tr_oat_validtoken",
    });

    const result = await authenticateOrganizationAccessToken("tr_oat_validtoken");

    expect(result).toEqual({ organizationId: "org_1" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);

    const call = updateManyMock.mock.calls[0][0];
    expect(call.where.id).toBe("oat_123");
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
    expect(cutoff.getTime()).toBe(Date.now() - OAT_LAST_ACCESSED_THROTTLE_MS);
  });

  test("skips updateMany when token is not found", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const result = await authenticateOrganizationAccessToken("tr_oat_validtoken");

    expect(result).toBeUndefined();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  test("skips updateMany when token doesn't start with prefix", async () => {
    const result = await authenticateOrganizationAccessToken("not_an_oat");

    expect(result).toBeUndefined();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

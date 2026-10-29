import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CLI login is started and approved on the same machine, so the network that minted the code
 * usually matches the approving browser's. In confirm mode a mismatch needs the approver's
 * explicit confirmation; in log mode only the outcome is logged. Expired codes are swept so
 * abandoned logins don't keep the requester IP.
 */

const db = vi.hoisted(() => ({ client: null as any }));
const mockEnv = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-cli-login-network",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  CLI_LOGIN_NETWORK_CHECK: "log" as "off" | "log" | "confirm",
}));
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/env.server", () => ({ env: mockEnv }));
vi.mock("~/services/logger.server", () => ({ logger }));
vi.mock("~/services/rbac.server", () => ({
  rbac: { isUsingPlugin: async () => false, setTokenRole: async () => ({ ok: true }) },
}));

import { postgresTest } from "@internal/testcontainers";
import { compareCliLoginNetworks } from "~/services/cliLoginNetwork.server";
import {
  AUTHORIZATION_CODE_TTL_MS,
  CliLoginNetworkConfirmationRequiredError,
  createAuthorizationCode,
  createPersonalAccessTokenFromAuthorizationCode,
  getMintableAuthorizationCode,
  sweepExpiredAuthorizationCodes,
} from "~/services/personalAccessToken.server";

vi.setConfig({ testTimeout: 60_000 });

let userCounter = 0;

async function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `cli-login-network-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

describe("compareCliLoginNetworks", () => {
  it("matches the same IPv4 address and nothing else", () => {
    expect(compareCliLoginNetworks("203.0.113.7", "203.0.113.7")).toBe("match");
    expect(compareCliLoginNetworks("203.0.113.7", "203.0.113.8")).toBe("mismatch");
  });

  it("matches IPv6 addresses in the same /64", () => {
    expect(compareCliLoginNetworks("2001:db8:1:2::10", "2001:0db8:0001:0002:abcd::1")).toBe(
      "match"
    );
    expect(compareCliLoginNetworks("2001:db8:1:2::10", "2001:db8:1:3::10")).toBe("mismatch");
  });

  it("treats an IPv4-mapped IPv6 address as IPv4", () => {
    expect(compareCliLoginNetworks("::ffff:203.0.113.7", "203.0.113.7")).toBe("match");
  });

  it("separates mixed address families and unknown addresses", () => {
    expect(compareCliLoginNetworks("203.0.113.7", "2001:db8::1")).toBe("mixed-family");
    expect(compareCliLoginNetworks(null, "203.0.113.7")).toBe("unknown");
    expect(compareCliLoginNetworks("203.0.113.7", "not-an-ip")).toBe("unknown");
  });
});

describe("CLI login network check", () => {
  beforeEach(() => {
    db.client = null;
    mockEnv.CLI_LOGIN_NETWORK_CHECK = "log";
    logger.info.mockClear();
  });

  postgresTest("stores the requester IP with the code", async ({ prisma }) => {
    db.client = prisma;

    const code = await createAuthorizationCode({ requesterIp: "203.0.113.7" });

    expect(await getMintableAuthorizationCode(code.code)).toMatchObject({
      requesterIp: "203.0.113.7",
    });
  });

  postgresTest("doesn't store a requester IP that isn't an IP address", async ({ prisma }) => {
    db.client = prisma;

    const forged = await createAuthorizationCode({ requesterIp: "your company VPN" });
    const ipv6 = await createAuthorizationCode({ requesterIp: " 2001:db8::1 " });

    expect(await getMintableAuthorizationCode(forged.code)).toMatchObject({ requesterIp: null });
    expect(await getMintableAuthorizationCode(ipv6.code)).toMatchObject({
      requesterIp: "2001:db8::1",
    });
  });

  postgresTest(
    "in log mode approves from another network and logs only the outcome",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const code = await createAuthorizationCode({ requesterIp: "198.51.100.1" });

      const token = await createPersonalAccessTokenFromAuthorizationCode(code.code, user.id, {
        approverIp: "203.0.113.7",
      });

      expect(token.networkMatch).toBe("mismatch");
      expect(token.requesterIp).toBe("198.51.100.1");

      const logged = JSON.stringify(logger.info.mock.calls);
      expect(logged).toContain("mismatch");
      expect(logged).not.toContain("198.51.100.1");
      expect(logged).not.toContain("203.0.113.7");
    }
  );

  postgresTest(
    "in confirm mode a login from another network needs confirmation",
    async ({ prisma }) => {
      db.client = prisma;
      mockEnv.CLI_LOGIN_NETWORK_CHECK = "confirm";
      const user = await createUser(prisma);
      const code = await createAuthorizationCode({ requesterIp: "198.51.100.1" });

      await expect(
        createPersonalAccessTokenFromAuthorizationCode(code.code, user.id, {
          approverIp: "203.0.113.7",
        })
      ).rejects.toBeInstanceOf(CliLoginNetworkConfirmationRequiredError);
      expect(
        await prisma.personalAccessToken.count({ where: { userId: user.id, revokedAt: null } })
      ).toBe(0);

      const token = await createPersonalAccessTokenFromAuthorizationCode(code.code, user.id, {
        approverIp: "203.0.113.7",
        confirmedDifferentNetwork: true,
      });
      expect(token.token).toMatch(/^tr_pat_/);
    }
  );

  postgresTest(
    "in confirm mode a login from the same network or an unknown one needs no confirmation",
    async ({ prisma }) => {
      db.client = prisma;
      mockEnv.CLI_LOGIN_NETWORK_CHECK = "confirm";
      const user = await createUser(prisma);

      const sameNetwork = await createAuthorizationCode({ requesterIp: "203.0.113.7" });
      const unknownNetwork = await createAuthorizationCode();

      await expect(
        createPersonalAccessTokenFromAuthorizationCode(sameNetwork.code, user.id, {
          approverIp: "203.0.113.7",
        })
      ).resolves.toMatchObject({ networkMatch: "match" });
      await expect(
        createPersonalAccessTokenFromAuthorizationCode(unknownNetwork.code, user.id, {
          approverIp: "203.0.113.7",
        })
      ).resolves.toMatchObject({ networkMatch: "unknown" });
    }
  );
});

describe("sweepExpiredAuthorizationCodes", () => {
  beforeEach(() => {
    db.client = null;
  });

  postgresTest("deletes only codes past their TTL", async ({ prisma }) => {
    db.client = prisma;
    const fresh = await createAuthorizationCode({ requesterIp: "203.0.113.7" });
    const expired = await Promise.all(
      Array.from({ length: 5 }, () => createAuthorizationCode({ requesterIp: "203.0.113.8" }))
    );
    await prisma.authorizationCode.updateMany({
      where: { id: { in: expired.map((code) => code.id) } },
      data: { createdAt: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS - 60_000) },
    });

    const result = await sweepExpiredAuthorizationCodes(prisma, { batchSize: 2 });

    expect(result).toEqual({ deleted: 5, pages: 3 });
    expect(await prisma.authorizationCode.findMany({ select: { id: true } })).toEqual([
      { id: fresh.id },
    ]);
  });

  postgresTest("stops after the page budget for one run", async ({ prisma }) => {
    db.client = prisma;
    const expired = await Promise.all(Array.from({ length: 5 }, () => createAuthorizationCode()));
    await prisma.authorizationCode.updateMany({
      where: { id: { in: expired.map((code) => code.id) } },
      data: { createdAt: new Date(Date.now() - AUTHORIZATION_CODE_TTL_MS - 60_000) },
    });

    const result = await sweepExpiredAuthorizationCodes(prisma, { batchSize: 2, maxPages: 1 });

    expect(result).toEqual({ deleted: 2, pages: 1 });
    expect(await prisma.authorizationCode.count()).toBe(3);
  });
});

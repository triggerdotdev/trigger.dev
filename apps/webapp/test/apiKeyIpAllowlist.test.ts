import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import { createEnvironmentApiKey, updateEnvironmentApiKeyIpRanges } from "~/models/api-key.server";
import { findEnvironmentByApiKeyWithResolution } from "~/models/runtimeEnvironment.server";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const ALLOWED_IP = "203.0.113.9";
const OTHER_IP = "198.51.100.7";

function bearerRequest(apiKey: string, forwardedFor?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (forwardedFor !== undefined) {
    headers["x-forwarded-for"] = forwardedFor;
  }
  return new Request("https://api.trigger.dev/api/v1/test", { headers });
}

async function setup(prisma: PrismaClient, allowedIpRanges: string[], scopes = ["admin"]) {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const apiKey = generateAdditionalApiKey("PRODUCTION").apiKey;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const record = await prisma.apiKey.create({
    data: {
      name: "Backend",
      keyHash,
      lastFour: apiKey.slice(-4),
      runtimeEnvironmentId: environment.id,
      createdByUserId: user.id,
      scopes,
      allowedIpRanges,
    },
  });
  return { environment, user, apiKey, record };
}

describe("API key IP allowlist: route builder auth", () => {
  postgresTest("accepts an allowed IP and records it as last used", async ({ prisma }) => {
    const { apiKey, record } = await setup(prisma, ["203.0.113.0/24"]);
    const rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });

    const result = await rbac.authenticateBearer(bearerRequest(apiKey, ALLOWED_IP));

    expect(result.ok).toBe(true);
    await expect(
      prisma.apiKey.findFirst({ where: { id: record.id }, select: { lastUsedIp: true } })
    ).resolves.toEqual({ lastUsedIp: ALLOWED_IP });
  });

  // Catches: an IP-restricted key authenticating from outside its ranges, by spoofing an
  // earlier X-Forwarded-For entry, or with no client IP; and a denial that differs from an
  // unknown key's response, which would tell a leaked key's holder the key is valid.
  postgresTest("rejects other, spoofed and missing IPs like an unknown key", async ({ prisma }) => {
    const { apiKey, record } = await setup(prisma, ["203.0.113.0/24"]);
    const rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
    const unknown = await rbac.authenticateBearer(
      bearerRequest(generateAdditionalApiKey("PRODUCTION").apiKey, OTHER_IP)
    );

    for (const forwardedFor of [OTHER_IP, `${ALLOWED_IP}, ${OTHER_IP}`, undefined]) {
      const denied = await rbac.authenticateBearer(bearerRequest(apiKey, forwardedFor));
      expect(denied.ok, String(forwardedFor)).toBe(false);
      if (denied.ok || unknown.ok) continue;
      expect({ status: denied.status, error: denied.error }).toEqual({
        status: unknown.status,
        error: unknown.error,
      });
    }
    await expect(
      prisma.apiKey.findFirst({ where: { id: record.id }, select: { lastUsedAt: true } })
    ).resolves.toEqual({ lastUsedAt: null });
  });
});

describe("API key IP allowlist: legacy route auth", () => {
  // Catches: legacy routes (schedules, public token minting, websockets) skipping the allowlist.
  postgresTest("rejects a disallowed IP and accepts an allowed one", async ({ prisma }) => {
    const { apiKey, environment } = await setup(prisma, ["203.0.113.0/24"]);

    await expect(
      findEnvironmentByApiKeyWithResolution(
        apiKey,
        { branchName: undefined, clientIp: OTHER_IP },
        prisma
      )
    ).resolves.toEqual({ ok: false, reason: "ip-not-allowed" });
    await expect(
      findEnvironmentByApiKeyWithResolution(
        apiKey,
        { branchName: undefined, clientIp: ALLOWED_IP },
        prisma
      )
    ).resolves.toMatchObject({ ok: true, environment: { id: environment.id } });
  });

  // Catches: a restricted key outside its ranges getting the restricted-key error, which
  // confirms the key is valid.
  postgresTest("checks the IP before the key's scopes", async ({ prisma }) => {
    const { apiKey } = await setup(prisma, ["203.0.113.0/24"], ["trigger:tasks:send-email"]);

    await expect(
      findEnvironmentByApiKeyWithResolution(
        apiKey,
        { branchName: undefined, clientIp: OTHER_IP },
        prisma
      )
    ).resolves.toEqual({ ok: false, reason: "ip-not-allowed" });
  });
});

describe("API key IP allowlist: managing ranges", () => {
  postgresTest("creates a key with normalized ranges", async ({ prisma }) => {
    const { environment, user } = await setup(prisma, []);

    const { apiKey } = await createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Restricted",
        presetId: "FULL_ACCESS",
        allowedIpRanges: [ALLOWED_IP, "2001:DB8::/32"],
      },
      {
        prismaClient: prisma,
        rbacController: plugin.create(
          { primary: prisma, replica: prisma },
          { forceFallback: true }
        ),
      }
    );

    expect(apiKey.allowedIpRanges).toEqual([`${ALLOWED_IP}/32`, "2001:db8::/32"]);
  });

  postgresTest(
    "updates ranges, and refuses private ranges and revoked keys",
    async ({ prisma }) => {
      const { environment, record } = await setup(prisma, []);
      const update = (allowedIpRanges: string[], allowPrivateIpRanges = false) =>
        updateEnvironmentApiKeyIpRanges(
          { environmentId: environment.id, apiKeyId: record.id, allowedIpRanges },
          { prismaClient: prisma, allowPrivateIpRanges }
        );

      await expect(update([ALLOWED_IP])).resolves.toEqual([`${ALLOWED_IP}/32`]);
      await expect(update(["10.0.0.0/8"])).rejects.toThrow(/private or reserved/);
      await expect(update(["10.0.0.0/8"], true)).resolves.toEqual(["10.0.0.0/8"]);

      await prisma.apiKey.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
      await expect(update([])).rejects.toThrow(/not found or already revoked/);
    }
  );
});

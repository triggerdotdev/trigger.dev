import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { createTestUser, uniqueId } from "./fixtures/environmentVariablesFixtures";

const db = vi.hoisted(() => ({ client: undefined as unknown as Record<PropertyKey, unknown> }));

vi.mock("~/db.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: new Proxy({}, { get: (_target, prop) => db.client[prop] }),
}));

vi.setConfig({ testTimeout: 60_000 });

async function createOrgWithVercel(prisma: PrismaClient, installationId: string) {
  const user = await createTestUser(prisma);
  const organization = await prisma.organization.create({
    data: {
      title: "Test Org",
      slug: uniqueId("org"),
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const integration = await VercelIntegrationRepository.createVercelOrgIntegration({
    accessToken: "vercel-token",
    teamId: "team_shared",
    installationId,
    organization,
    origin: "dashboard",
  });
  return prisma.organizationIntegration.findUniqueOrThrow({
    where: { id: integration.id },
    include: { tokenReference: true },
  });
}

function errorResponse(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFoundResponse() {
  return errorResponse(404, "not_found");
}

describe("uninstallVercelIntegration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  postgresTest("keeps a configuration another organization uses", async ({ prisma }) => {
    db.client = prisma as unknown as Record<PropertyKey, unknown>;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const installationId = uniqueId("icfg");
    const orgA = await createOrgWithVercel(prisma, installationId);
    const orgB = await createOrgWithVercel(prisma, installationId);

    const result = await VercelIntegrationRepository.uninstallVercelIntegration(orgA);

    expect(result.isOk() && result.value).toEqual({ authInvalid: false, sharedWith: orgB.id });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  postgresTest("deletes a configuration only one organization uses", async ({ prisma }) => {
    db.client = prisma as unknown as Record<PropertyKey, unknown>;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(notFoundResponse());
    const installationId = uniqueId("icfg");
    const orgA = await createOrgWithVercel(prisma, installationId);
    await createOrgWithVercel(prisma, uniqueId("icfg"));

    const result = await VercelIntegrationRepository.uninstallVercelIntegration(orgA);

    expect(result.isOk() && result.value).toEqual({ authInvalid: false });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  postgresTest("keeps the rows when Vercel fails to delete", async ({ prisma }) => {
    db.client = prisma as unknown as Record<PropertyKey, unknown>;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(500, "internal_server_error"));
    const orgA = await createOrgWithVercel(prisma, uniqueId("icfg"));

    const result = await VercelIntegrationRepository.uninstallVercelIntegration(orgA);

    expect(result.isErr() && result.error.reason).toBe("other");
    expect(fetchSpy).toHaveBeenCalled();
  });

  postgresTest(
    "ignores a soft-deleted integration on the same installation",
    async ({ prisma }) => {
      db.client = prisma as unknown as Record<PropertyKey, unknown>;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(notFoundResponse());
      const installationId = uniqueId("icfg");
      const orgA = await createOrgWithVercel(prisma, installationId);
      const orgB = await createOrgWithVercel(prisma, installationId);
      await prisma.organizationIntegration.update({
        where: { id: orgB.id },
        data: { deletedAt: new Date() },
      });

      const result = await VercelIntegrationRepository.uninstallVercelIntegration(orgA);

      expect(result.isOk() && result.value).toEqual({ authInvalid: false });
      expect(fetchSpy).toHaveBeenCalledOnce();
    }
  );
});

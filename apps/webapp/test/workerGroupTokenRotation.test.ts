import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    prisma: {},
    $replica: {},
    sqlDatabaseSchema: Prisma.sql([`public`]),
    runOpsNewPrisma: {},
    runOpsLegacyPrisma: {},
  };
});
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));

import { WorkerGroupTokenService } from "~/v3/services/worker/workerGroupTokenService.server";

async function createGroup(prisma: PrismaClient, service: WorkerGroupTokenService) {
  const token = await service.createToken();
  const group = await prisma.workerInstanceGroup.create({
    data: {
      type: "MANAGED",
      name: `group-${token.id}`,
      masterQueue: `master-${token.id}`,
      tokenId: token.id,
    },
  });
  return { group, plaintext: token.plaintext };
}

async function resolves(service: WorkerGroupTokenService, token: string, groupId: string) {
  const found = await service.findWorkerGroup({ token });
  return found?.id === groupId;
}

describe("WorkerGroupTokenService rotation", () => {
  postgresTest("accepts both tokens during grace, only the new one after", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group, plaintext: oldToken } = await createGroup(prisma, service);

    const rotated = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
    expect(rotated.outcome).toBe("rotated");
    if (rotated.outcome !== "rotated") return;

    expect(await resolves(service, oldToken, group.id)).toBe(true); // Catches: old token 401s during grace
    expect(await resolves(service, rotated.plaintext, group.id)).toBe(true);

    const found = await service.findWorkerGroup({ token: oldToken });
    expect(found?.tokenValidUntil?.getTime()).toBe(rotated.previousTokenValidUntil.getTime());
    const current = await service.findWorkerGroup({ token: rotated.plaintext });
    expect(current?.tokenValidUntil).toBeUndefined();

    await prisma.workerGroupToken.update({
      where: { id: group.tokenId },
      data: { previousTokenValidUntil: new Date(Date.now() - 1_000) },
    });

    expect(await resolves(service, oldToken, group.id)).toBe(false); // Catches: expired previous token still accepted
    expect(await resolves(service, rotated.plaintext, group.id)).toBe(true);
  });

  postgresTest("revoking the previous token rejects it immediately", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group, plaintext: oldToken } = await createGroup(prisma, service);

    const rotated = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
    expect(rotated.outcome).toBe("rotated");
    if (rotated.outcome !== "rotated") return;

    expect(await service.revokePreviousToken({ workerGroupId: group.id })).toBeTruthy();

    expect(await resolves(service, oldToken, group.id)).toBe(false);
    expect(await resolves(service, rotated.plaintext, group.id)).toBe(true);
  });

  postgresTest(
    "rejects a rotation whose read was overtaken by another write",
    async ({ prisma }) => {
      const { group, plaintext: oldToken } = await createGroup(
        prisma,
        new WorkerGroupTokenService({ prisma })
      );

      const interleaved = prisma.$extends({
        query: {
          workerInstanceGroup: {
            async findFirst({ args, query }) {
              const result = await query(args);
              await prisma.workerGroupToken.update({
                where: { id: group.tokenId },
                data: { tokenHash: `overtaken-${group.tokenId}` },
              });
              return result;
            },
          },
        },
      }) as unknown as PrismaClient;

      const result = await new WorkerGroupTokenService({ prisma: interleaved }).rotateToken({
        workerGroupId: group.id,
        graceMs: 60_000,
      });

      expect(result.outcome).toBe("conflict"); // Catches: stale read overwrites a newer token
      const row = await prisma.workerGroupToken.findUniqueOrThrow({ where: { id: group.tokenId } });
      expect(row.tokenHash).toBe(`overtaken-${group.tokenId}`);
      expect(row.previousTokenHash).toBeNull();
      expect(await resolves(new WorkerGroupTokenService({ prisma }), oldToken, group.id)).toBe(
        false
      );
    }
  );

  postgresTest(
    "refuses a second rotation while the previous token is in grace",
    async ({ prisma }) => {
      const service = new WorkerGroupTokenService({ prisma });
      const { group, plaintext: oldToken } = await createGroup(prisma, service);

      const first = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
      expect(first.outcome).toBe("rotated");
      if (first.outcome !== "rotated") return;

      const second = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
      expect(second.outcome).toBe("grace_active");
      expect(await resolves(service, oldToken, group.id)).toBe(true); // Catches: double rotate strands the fleet on the old token
      expect(await resolves(service, first.plaintext, group.id)).toBe(true);

      await service.revokePreviousToken({ workerGroupId: group.id });
      const third = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
      expect(third.outcome).toBe("rotated");
    }
  );

  postgresTest("returns not_found for an unknown worker group", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const result = await service.rotateToken({ workerGroupId: "missing", graceMs: 60_000 });
    expect(result.outcome).toBe("not_found");
  });
});

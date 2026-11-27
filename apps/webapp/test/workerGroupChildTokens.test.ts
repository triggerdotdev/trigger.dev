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

describe("worker group child tokens", () => {
  postgresTest("child and global tokens resolve the same group", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group, plaintext: global } = await createGroup(prisma, service);
    const child = await service.createChildToken({ workerGroupId: group.id });

    const viaChild = await service.findWorkerGroup({ token: child!.plaintext });
    expect(viaChild?.id).toBe(group.id);
    expect(viaChild?.tokenKind).toBe("child");

    const viaGlobal = await service.findWorkerGroup({ token: global });
    expect(viaGlobal?.id).toBe(group.id);
    expect(viaGlobal?.tokenKind).toBe("global");
  });

  postgresTest("rotating the global token leaves child tokens valid", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group, plaintext: oldGlobal } = await createGroup(prisma, service);
    const child = await service.createChildToken({ workerGroupId: group.id });

    const rotated = await service.rotateToken({ workerGroupId: group.id, graceMs: 60_000 });
    expect(rotated.outcome).toBe("rotated");

    expect((await service.findWorkerGroup({ token: oldGlobal }))?.tokenKind).toBe(
      "previous-global"
    );
    expect((await service.findWorkerGroup({ token: child!.plaintext }))?.tokenKind).toBe("child");
  });

  postgresTest("delete removes only a child token of that group", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group, plaintext: global } = await createGroup(prisma, service);
    const { group: other } = await createGroup(prisma, service);
    const child = await service.createChildToken({ workerGroupId: group.id });

    expect(await service.deleteChildToken({ workerGroupId: other.id, tokenId: child!.id })).toBe(
      false
    );
    expect(
      await service.deleteChildToken({ workerGroupId: group.id, tokenId: group.tokenId })
    ).toBe(false);
    expect(await service.findWorkerGroup({ token: global })).not.toBeNull();

    expect(await service.deleteChildToken({ workerGroupId: group.id, tokenId: child!.id })).toBe(
      true
    );
    expect(await service.findWorkerGroup({ token: child!.plaintext })).toBeNull();
  });

  postgresTest("deleting the group deletes its child tokens", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    const { group } = await createGroup(prisma, service);
    const child = await service.createChildToken({ workerGroupId: group.id });

    await prisma.workerInstanceGroup.delete({ where: { id: group.id } });

    expect(await prisma.workerGroupToken.findFirst({ where: { id: child!.id } })).toBeNull();
  });

  postgresTest("minting for an unknown group returns nothing", async ({ prisma }) => {
    const service = new WorkerGroupTokenService({ prisma });
    expect(await service.createChildToken({ workerGroupId: "missing" })).toBeUndefined();
  });
});

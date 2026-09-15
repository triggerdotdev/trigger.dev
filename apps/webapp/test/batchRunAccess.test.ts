import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { PostgresRunStore } from "@internal/run-store";
import { containerTest } from "@internal/testcontainers";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { findBatchRunIdForUser } from "~/v3/services/batchRunAccess.server";

vi.setConfig({ testTimeout: 60_000 });

const rand = () => Math.random().toString(36).slice(2, 10);

// The batch-resume route was previously unauthenticated. This is the org-scoped
// ownership gate: a user may only resolve a batch in an org they belong to.
describe("findBatchRunIdForUser", () => {
  containerTest(
    "resolves a batch for an org member, by friendlyId and by internal id",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const member = await prisma.user.create({
        data: { email: `member_${rand()}@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      await prisma.orgMember.create({
        data: { organizationId: env.organizationId, userId: member.id },
      });
      const batchId = BatchId.generate();
      const batch = await prisma.batchTaskRun.create({
        data: { id: batchId.id, friendlyId: batchId.friendlyId, runtimeEnvironmentId: env.id },
      });

      expect(await findBatchRunIdForUser(prisma, store, batch.friendlyId, member.id)).toBe(
        batch.id
      );
      expect(await findBatchRunIdForUser(prisma, store, batch.id, member.id)).toBe(batch.id);
    }
  );

  containerTest(
    "returns null for a user who is not a member of the batch's org",
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const batchId = BatchId.generate();
      const batch = await prisma.batchTaskRun.create({
        data: { id: batchId.id, friendlyId: batchId.friendlyId, runtimeEnvironmentId: env.id },
      });
      // A user who exists but isn't a member of the org.
      const stranger = await prisma.user.create({
        data: { email: `stranger_${rand()}@example.com`, authenticationMethod: "MAGIC_LINK" },
      });

      expect(await findBatchRunIdForUser(prisma, store, batch.friendlyId, stranger.id)).toBeNull();
      expect(await findBatchRunIdForUser(prisma, store, batch.id, stranger.id)).toBeNull();
    }
  );
});

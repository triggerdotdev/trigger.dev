import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer, deserialiseSnapshot } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { processBufferedCancelBulkAction } from "~/v3/mollifier/bulkActionBuffer.server";

// pgRow lookup stub — no PG rows exist for these runs, so the
// mutateWithFallback inside the helper always takes the buffer-patch path.
const fakePrismaReader = {
  taskRun: { findFirst: vi.fn(async () => null) },
};

vi.mock("~/v3/mollifier/mutateWithFallback.server", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    // Re-export the real `mutateWithFallback`; the redisTest injects the
    // real MollifierBuffer via getBuffer, and we pass our fake prisma
    // reader via prismaReplica/Writer below. The bulk-action helper
    // currently doesn't expose deps for prisma yet — see assertion below.
  };
});

const SNAPSHOT = (overrides: Record<string, unknown>) => ({
  taskIdentifier: "hello-world",
  isTest: false,
  tags: ["alpha"],
  ...overrides,
});

async function seedEntry(
  buffer: MollifierBuffer,
  args: { runId: string; envId: string; orgId: string; snapshot: Record<string, unknown> },
) {
  await buffer.accept({
    runId: args.runId,
    envId: args.envId,
    orgId: args.orgId,
    payload: JSON.stringify(args.snapshot),
    taskIdentifier:
      typeof args.snapshot.taskIdentifier === "string"
        ? args.snapshot.taskIdentifier
        : undefined,
  });
}

describe("processBufferedCancelBulkAction", () => {
  redisTest(
    "writes cancelledAt into every buffered snapshot matching the filter",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        await seedEntry(buffer, {
          runId: "run_match_1",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({}),
        });
        await seedEntry(buffer, {
          runId: "run_match_2",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({}),
        });
        await seedEntry(buffer, {
          runId: "run_skip_other_task",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({ taskIdentifier: "other-task" }),
        });

        const result = await processBufferedCancelBulkAction(
          {
            envId: "env_a",
            organizationId: "org_1",
            filters: { tasks: ["hello-world"] },
            cancelReason: "bulk-test",
          },
          {
            getBuffer: () => buffer,
            prismaReplica: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaReplica"],
            prismaWriter: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaWriter"],
          },
        );

        expect(result.successCount).toBe(2);
        expect(result.failureCount).toBe(0);

        const matchedEntry = await buffer.getEntry("run_match_1");
        const matchedSnap = deserialiseSnapshot(matchedEntry!.payload) as Record<string, unknown>;
        expect(matchedSnap.cancelledAt).toBeTypeOf("string");
        expect(matchedSnap.cancelReason).toBe("bulk-test");

        const skippedEntry = await buffer.getEntry("run_skip_other_task");
        const skippedSnap = deserialiseSnapshot(skippedEntry!.payload) as Record<string, unknown>;
        expect(skippedSnap.cancelledAt).toBeUndefined();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "respects the tags filter (any-overlap semantics)",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        await seedEntry(buffer, {
          runId: "run_with_alpha",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({ tags: ["alpha", "extra"] }),
        });
        await seedEntry(buffer, {
          runId: "run_with_beta",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({ tags: ["beta"] }),
        });

        const result = await processBufferedCancelBulkAction(
          {
            envId: "env_a",
            organizationId: "org_1",
            filters: { tags: ["alpha"] },
            cancelReason: "bulk-test",
          },
          {
            getBuffer: () => buffer,
            prismaReplica: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaReplica"],
            prismaWriter: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaWriter"],
          },
        );

        expect(result.successCount).toBe(1);
        const betaEntry = await buffer.getEntry("run_with_beta");
        const betaSnap = deserialiseSnapshot(betaEntry!.payload) as Record<string, unknown>;
        expect(betaSnap.cancelledAt).toBeUndefined();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "filters by isTest exactly",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
      try {
        await seedEntry(buffer, {
          runId: "run_is_test",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({ isTest: true }),
        });
        await seedEntry(buffer, {
          runId: "run_not_test",
          envId: "env_a",
          orgId: "org_1",
          snapshot: SNAPSHOT({ isTest: false }),
        });

        const result = await processBufferedCancelBulkAction(
          {
            envId: "env_a",
            organizationId: "org_1",
            filters: { isTest: true },
            cancelReason: "bulk-test",
          },
          {
            getBuffer: () => buffer,
            prismaReplica: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaReplica"],
            prismaWriter: fakePrismaReader as unknown as Parameters<typeof processBufferedCancelBulkAction>[1]["prismaWriter"],
          },
        );

        expect(result.successCount).toBe(1);
        const notTestEntry = await buffer.getEntry("run_not_test");
        const notTestSnap = deserialiseSnapshot(notTestEntry!.payload) as Record<string, unknown>;
        expect(notTestSnap.cancelledAt).toBeUndefined();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest("returns zero counts when buffer is null (mollifier disabled)", async () => {
    const result = await processBufferedCancelBulkAction(
      {
        envId: "env_a",
        organizationId: "org_1",
        filters: {},
        cancelReason: "bulk-test",
      },
      { getBuffer: () => null },
    );
    expect(result).toEqual({ successCount: 0, failureCount: 0 });
  });

  redisTest("returns zero counts when no entries match the filter", async ({ redisOptions }) => {
    const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 60 });
    try {
      await seedEntry(buffer, {
        runId: "run_no_match",
        envId: "env_a",
        orgId: "org_1",
        snapshot: SNAPSHOT({ taskIdentifier: "other-task" }),
      });
      const result = await processBufferedCancelBulkAction(
        {
          envId: "env_a",
          organizationId: "org_1",
          filters: { tasks: ["hello-world"] },
          cancelReason: "bulk-test",
        },
        { getBuffer: () => buffer },
      );
      expect(result).toEqual({ successCount: 0, failureCount: 0 });
    } finally {
      await buffer.close();
    }
  });
});

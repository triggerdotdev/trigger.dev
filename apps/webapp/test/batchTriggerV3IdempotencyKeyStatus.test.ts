import { describe, expect, it, vi } from "vitest";

// Mock DB layer singletons
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

import type { TaskRunStatus } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BatchTriggerV3Service } from "~/v3/services/batchTriggerV3.server";
import { shouldIdempotencyKeyBeCleared } from "~/v3/taskStatus";

vi.setConfig({ testTimeout: 60_000 });

function fakeEnv(): AuthenticatedEnvironment {
  return {
    id: "env_test_123",
    organizationId: "org_test_123",
    organization: { featureFlags: {} },
    type: "DEVELOPMENT",
  } as unknown as AuthenticatedEnvironment;
}

describe("shouldIdempotencyKeyBeCleared (unit)", () => {
  const CLEARABLE_STATUSES: TaskRunStatus[] = [
    "CRASHED",
    "SYSTEM_FAILURE",
    "TIMED_OUT",
    "EXPIRED",
    "COMPLETED_WITH_ERRORS",
    "INTERRUPTED",
  ];

  const NON_CLEARABLE_STATUSES: TaskRunStatus[] = [
    "COMPLETED_SUCCESSFULLY",
    "EXECUTING",
    "PENDING",
    "WAITING_FOR_DEPLOY",
    "PAUSED",
    "DELAYED",
    "CANCELED",
  ];

  for (const status of CLEARABLE_STATUSES) {
    it(`returns true for clearable failure status: ${status}`, () => {
      expect(shouldIdempotencyKeyBeCleared(status)).toBe(true);
    });
  }

  for (const status of NON_CLEARABLE_STATUSES) {
    it(`returns false for non-clearable status: ${status}`, () => {
      expect(shouldIdempotencyKeyBeCleared(status)).toBe(false);
    });
  }
});

describe("BatchTriggerV3Service #prepareRunData idempotency key status check", () => {
  const CLEARABLE_FAILURE_STATUSES: TaskRunStatus[] = [
    "CRASHED",
    "SYSTEM_FAILURE",
    "TIMED_OUT",
    "EXPIRED",
    "COMPLETED_WITH_ERRORS",
    "INTERRUPTED",
  ];

  const NON_CLEARABLE_STATUSES: TaskRunStatus[] = [
    "COMPLETED_SUCCESSFULLY",
    "EXECUTING",
    "PENDING",
    "WAITING_FOR_DEPLOY",
  ];

  for (const status of CLEARABLE_FAILURE_STATUSES) {
    it(`clears idempotency key and mints fresh run for clearable status: ${status}`, async () => {
      const clearIdempotencyKeyMock = vi.fn().mockResolvedValue({ count: 1 });
      const mockRunStore = {
        findRunsByIdempotencyKeys: vi.fn().mockResolvedValue([
          {
            id: "run_internal_dead",
            createdAt: new Date(),
            friendlyId: "run_dead_123",
            idempotencyKey: "key_dead",
            idempotencyKeyExpiresAt: null,
            status,
          },
        ]),
        clearIdempotencyKey: clearIdempotencyKeyMock,
      };

      const service = new BatchTriggerV3Service(
        undefined,
        undefined,
        {} as any,
        mockRunStore as any,
        async () => "cuid"
      );

      const body = {
        items: [
          {
            task: "test-task",
            payload: "{}",
            options: {
              idempotencyKey: "key_dead",
            },
          },
        ],
      };

      const runs = await (service as any).prepareRunData(fakeEnv(), body, "batch_123");

      // Verify clearIdempotencyKey was called for the dead run
      expect(clearIdempotencyKeyMock).toHaveBeenCalledTimes(1);
      expect(clearIdempotencyKeyMock).toHaveBeenCalledWith(
        { byFriendlyIds: ["run_dead_123"] },
        expect.anything()
      );

      // Verify the run returned is NOT cached and has a freshly minted ID
      expect(runs).toHaveLength(1);
      expect(runs[0].isCached).toBe(false);
      expect(runs[0].id).not.toBe("run_dead_123");
      expect(runs[0].taskIdentifier).toBe("test-task");
      expect(runs[0].idempotencyKey).toBe("key_dead");
    });
  }

  for (const status of NON_CLEARABLE_STATUSES) {
    it(`reuses cached run and does NOT clear key for status: ${status}`, async () => {
      const clearIdempotencyKeyMock = vi.fn().mockResolvedValue({ count: 0 });
      const mockRunStore = {
        findRunsByIdempotencyKeys: vi.fn().mockResolvedValue([
          {
            id: "run_internal_live",
            createdAt: new Date(),
            friendlyId: "run_live_123",
            idempotencyKey: "key_live",
            idempotencyKeyExpiresAt: null,
            status,
          },
        ]),
        clearIdempotencyKey: clearIdempotencyKeyMock,
      };

      const service = new BatchTriggerV3Service(
        undefined,
        undefined,
        {} as any,
        mockRunStore as any,
        async () => "cuid"
      );

      const body = {
        items: [
          {
            task: "test-task",
            payload: "{}",
            options: {
              idempotencyKey: "key_live",
            },
          },
        ],
      };

      const runs = await (service as any).prepareRunData(fakeEnv(), body, "batch_123");

      // Verify clearIdempotencyKey was NOT called
      expect(clearIdempotencyKeyMock).not.toHaveBeenCalled();

      // Verify the run returned IS cached and preserves existing run ID
      expect(runs).toHaveLength(1);
      expect(runs[0].isCached).toBe(true);
      expect(runs[0].id).toBe("run_live_123");
      expect(runs[0].taskIdentifier).toBe("test-task");
      expect(runs[0].idempotencyKey).toBe("key_live");
    });
  }

  it("handles a mixed batch with fresh keys, live cached runs, and dead runs correctly", async () => {
    const clearIdempotencyKeyMock = vi.fn().mockResolvedValue({ count: 7 });
    const mockRunStore = {
      findRunsByIdempotencyKeys: vi.fn().mockImplementation(async ({ idempotencyKeys }) => {
        const matches = [
          {
            id: "r1",
            createdAt: new Date(),
            friendlyId: "run_crashed",
            idempotencyKey: "k_crashed",
            idempotencyKeyExpiresAt: null,
            status: "CRASHED",
          },
          {
            id: "r2",
            createdAt: new Date(),
            friendlyId: "run_success",
            idempotencyKey: "k_success",
            idempotencyKeyExpiresAt: null,
            status: "COMPLETED_SUCCESSFULLY",
          },
          {
            id: "r3",
            createdAt: new Date(),
            friendlyId: "run_sys_fail",
            idempotencyKey: "k_sys_fail",
            idempotencyKeyExpiresAt: null,
            status: "SYSTEM_FAILURE",
          },
          {
            id: "r4",
            createdAt: new Date(),
            friendlyId: "run_executing",
            idempotencyKey: "k_executing",
            idempotencyKeyExpiresAt: null,
            status: "EXECUTING",
          },
          {
            id: "r5",
            createdAt: new Date(),
            friendlyId: "run_timeout",
            idempotencyKey: "k_timeout",
            idempotencyKeyExpiresAt: null,
            status: "TIMED_OUT",
          },
          {
            id: "r6",
            createdAt: new Date(),
            friendlyId: "run_errors",
            idempotencyKey: "k_errors",
            idempotencyKeyExpiresAt: null,
            status: "COMPLETED_WITH_ERRORS",
          },
          {
            id: "r7",
            createdAt: new Date(),
            friendlyId: "run_interrupted",
            idempotencyKey: "k_interrupted",
            idempotencyKeyExpiresAt: null,
            status: "INTERRUPTED",
          },
          {
            id: "r8",
            createdAt: new Date(),
            friendlyId: "run_expired_status",
            idempotencyKey: "k_expired_status",
            idempotencyKeyExpiresAt: null,
            status: "EXPIRED",
          },
          {
            id: "r9",
            createdAt: new Date(),
            friendlyId: "run_expired_ttl",
            idempotencyKey: "k_expired_ttl",
            idempotencyKeyExpiresAt: new Date(Date.now() - 10_000),
            status: "PENDING",
          },
        ];
        return matches.filter((m) => idempotencyKeys.includes(m.idempotencyKey));
      }),
      clearIdempotencyKey: clearIdempotencyKeyMock,
    };

    const service = new BatchTriggerV3Service(
      undefined,
      undefined,
      {} as any,
      mockRunStore as any,
      async () => "cuid"
    );

    const body = {
      items: [
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_crashed" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_success" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_sys_fail" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_executing" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_timeout" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_errors" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_interrupted" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_expired_status" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_expired_ttl" } },
        { task: "t1", payload: "{}", options: { idempotencyKey: "k_brand_new" } },
      ],
    };

    const runs = await (service as any).prepareRunData(fakeEnv(), body, "batch_mixed_123");

    // All clearable failure statuses + expired TTL run must be cleared
    expect(clearIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    const clearedIds = clearIdempotencyKeyMock.mock.calls[0][0].byFriendlyIds.sort();
    expect(clearedIds).toEqual(
      [
        "run_crashed",
        "run_sys_fail",
        "run_timeout",
        "run_errors",
        "run_interrupted",
        "run_expired_status",
        "run_expired_ttl",
      ].sort()
    );

    expect(runs).toHaveLength(10);
    // k_crashed: cleared, minted new
    expect(runs[0].isCached).toBe(false);
    expect(runs[0].id).not.toBe("run_crashed");
    // k_success: live, cached
    expect(runs[1].isCached).toBe(true);
    expect(runs[1].id).toBe("run_success");
    // k_sys_fail: cleared, minted new
    expect(runs[2].isCached).toBe(false);
    expect(runs[2].id).not.toBe("run_sys_fail");
    // k_executing: live, cached
    expect(runs[3].isCached).toBe(true);
    expect(runs[3].id).toBe("run_executing");
    // k_timeout: cleared, minted new
    expect(runs[4].isCached).toBe(false);
    expect(runs[4].id).not.toBe("run_timeout");
    // k_errors: cleared, minted new
    expect(runs[5].isCached).toBe(false);
    expect(runs[5].id).not.toBe("run_errors");
    // k_interrupted: cleared, minted new
    expect(runs[6].isCached).toBe(false);
    expect(runs[6].id).not.toBe("run_interrupted");
    // k_expired_status: cleared, minted new
    expect(runs[7].isCached).toBe(false);
    expect(runs[7].id).not.toBe("run_expired_status");
    // k_expired_ttl: cleared, minted new
    expect(runs[8].isCached).toBe(false);
    expect(runs[8].id).not.toBe("run_expired_ttl");
    // k_brand_new: fresh, minted new
    expect(runs[9].isCached).toBe(false);
  });
});

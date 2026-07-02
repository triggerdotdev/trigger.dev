import { describe, expect, it, vi } from "vitest";

// Module-level db wiring is imported transitively by the service file. The mint
// helper under test never touches the DB (it is driven with injected deps), so
// these empty singletons only satisfy the import graph — same boundary pattern
// as triggerTask.server.test.ts and runEngineBatchTriggerStoreRouting.test.ts.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

import { BatchId, generateKsuidId, ownerEngine, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BatchTriggerV3Service } from "~/v3/services/batchTriggerV3.server";

vi.setConfig({ testTimeout: 60_000 });

const CUID_LEN = 25;
const KSUID_LEN = 27;

// Minimal AuthenticatedEnvironment — only the fields the mint path reads
// (organizationId, id, organization.featureFlags) need to be real. A root batch
// (no parentRunId) with no ksuid override mints cuid, which is the env-default
// branch we assert on below.
function fakeEnv(): AuthenticatedEnvironment {
  return {
    id: "env_123",
    organizationId: "org_123",
    organization: { featureFlags: {} },
  } as unknown as AuthenticatedEnvironment;
}

// Build the service with resolveMintKind forced to "cuid" (its production default
// when split is off / org not cut over), proving the CHILD branch overrides the env
// default purely from the parent's id-shape.
function buildService() {
  return new BatchTriggerV3Service(undefined, undefined, {} as any, {} as any, async () => "cuid");
}

describe("BatchTriggerV3Service child-residency inheritance", () => {
  it("a ksuid parent yields ksuid (NEW) child friendlyIds", async () => {
    const service = buildService();
    const parentFriendlyId = RunId.toFriendlyId(
      // 27-char ksuid internal id → NEW residency parent
      "a".repeat(KSUID_LEN)
    );
    expect(ownerEngine(RunId.fromFriendlyId(parentFriendlyId))).toBe("NEW");

    const childFriendlyId = await (service as any).mintChildFriendlyId(fakeEnv(), parentFriendlyId);

    expect(RunId.fromFriendlyId(childFriendlyId).length).toBe(KSUID_LEN);
    expect(ownerEngine(RunId.fromFriendlyId(childFriendlyId))).toBe("NEW");
  });

  it("a cuid parent yields cuid (LEGACY) child friendlyIds", async () => {
    const service = buildService();
    const parentFriendlyId = RunId.generate().friendlyId; // cuid (25) → LEGACY parent
    expect(ownerEngine(RunId.fromFriendlyId(parentFriendlyId))).toBe("LEGACY");

    const childFriendlyId = await (service as any).mintChildFriendlyId(fakeEnv(), parentFriendlyId);

    expect(RunId.fromFriendlyId(childFriendlyId).length).toBe(CUID_LEN);
    expect(ownerEngine(RunId.fromFriendlyId(childFriendlyId))).toBe("LEGACY");
  });

  it("a ROOT batch (no parentRunId) mints by the env setting (cuid default here)", async () => {
    const service = buildService();
    const childFriendlyId = await (service as any).mintChildFriendlyId(fakeEnv(), undefined);
    expect(RunId.fromFriendlyId(childFriendlyId).length).toBe(CUID_LEN);
    expect(ownerEngine(RunId.fromFriendlyId(childFriendlyId))).toBe("LEGACY");
  });

  // A root batch's children are anchored to the batch's friendlyId, NOT to a
  // re-resolution of the per-org flag. Even with the env flag forced to "cuid" (a flip
  // away from the batch's residency), a ksuid batch anchor yields ksuid children — so
  // batch + children stay co-resident and TaskRun.batchId never crosses the seam.
  it("a ksuid batch anchor yields ksuid children even when the env flag resolves cuid", async () => {
    const service = buildService(); // resolveMintKind forced to "cuid"
    const batchFriendlyId = BatchId.toFriendlyId(generateKsuidId()); // ksuid (NEW) batch
    expect(ownerEngine(batchFriendlyId)).toBe("NEW");

    const childFriendlyId = await (service as any).mintChildFriendlyId(fakeEnv(), batchFriendlyId);

    expect(RunId.fromFriendlyId(childFriendlyId).length).toBe(KSUID_LEN);
    expect(ownerEngine(RunId.fromFriendlyId(childFriendlyId))).toBe("NEW");
  });

  // The cuid mirror: a cuid batch anchor yields cuid children even if the flag flipped ON.
  it("a cuid batch anchor yields cuid children even when the env flag resolves ksuid", async () => {
    const service = new BatchTriggerV3Service(
      undefined,
      undefined,
      {} as any,
      {} as any,
      async () => "ksuid" // env flag flipped ON mid-batch
    );
    const batchFriendlyId = BatchId.generate().friendlyId; // cuid (LEGACY) batch
    expect(ownerEngine(batchFriendlyId)).toBe("LEGACY");

    const childFriendlyId = await (service as any).mintChildFriendlyId(fakeEnv(), batchFriendlyId);

    expect(RunId.fromFriendlyId(childFriendlyId).length).toBe(CUID_LEN);
    expect(ownerEngine(RunId.fromFriendlyId(childFriendlyId))).toBe("LEGACY");
  });
});

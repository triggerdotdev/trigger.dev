import type { RunStore } from "@internal/run-store";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { LegacyPostgresWaitpointCoordinator } from "./legacyPostgresCoordinator.js";

// These drive the real create sites, not the mint helper: a test calling the helper directly
// passes even when a site stops passing its anchor.
const GEN2_RUN = `${"a".repeat(24)}a2`;
const GEN1_RUN = `${"a".repeat(24)}01`;
const GEN2_BATCH = `${"d".repeat(24)}b2`;

type Captured = { id?: string; friendlyId?: string };

function coordinatorCapturing(captured: Captured) {
  const runStore = {
    findWaitpoint: async () => null,
    upsertWaitpoint: async (args: { create: Captured }) => {
      captured.id = args.create.id;
      captured.friendlyId = args.create.friendlyId;
      return { id: args.create.id } as unknown as Waitpoint;
    },
  } as unknown as RunStore;

  return new LegacyPostgresWaitpointCoordinator({
    runStore,
    prisma: {} as unknown as PrismaClient,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger,
  });
}

describe("createDateTimeWaitpoint stamps the anchor's shard", () => {
  it("a gen-2 run anchor yields a gen-2 waitpoint id", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createDateTimeWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
      completedAfter: new Date(),
    });

    expect(captured.id).toHaveLength(26);
    expect(captured.id?.[24]).toBe("a");
    expect(captured.id?.[25]).toBe("2");
    expect(captured.friendlyId).toBe(`waitpoint_${captured.id}`);
  });

  it("a gen-1 run anchor keeps a cuid", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createDateTimeWaitpoint({
      runId: GEN1_RUN,
      projectId: "proj",
      environmentId: "env",
      completedAfter: new Date(),
    });

    expect(captured.id).toHaveLength(25);
  });
});

describe("createManualWaitpoint stamps the anchor's shard", () => {
  it("a gen-2 run anchor yields a gen-2 waitpoint id", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
    });

    expect(captured.id?.[24]).toBe("a");
    expect(captured.id?.[25]).toBe("2");
  });

  it("a standalone token mints by the environment's shard, not by an anchor", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "c",
    });

    expect(captured.id?.[24]).toBe("c");
    expect(captured.id?.[25]).toBe("2");
  });

  it("a standalone token on a gen-1 environment keeps a cuid", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "new",
      standaloneResidency: "NEW",
    });

    expect(captured.id).toHaveLength(25);
  });

  it("an owning run outranks the environment shard", async () => {
    const captured: Captured = {};
    await coordinatorCapturing(captured).createManualWaitpoint({
      runId: GEN2_RUN,
      projectId: "proj",
      environmentId: "env",
      standaloneShardKey: "c",
    });

    expect(captured.id?.[24]).toBe("a");
  });
});

describe("mintAssociatedWaitpointData stamps the anchor's shard", () => {
  // Written inside the run store, which has no stamp check, so an unstamped id here strands the
  // parent run with nothing logged.
  const mint = (anchorRunId: string) =>
    coordinatorCapturing({}).mintAssociatedWaitpointData({
      projectId: "proj",
      environmentId: "env",
      anchorRunId,
    });

  it("a gen-2 run anchor yields a gen-2 waitpoint id", () => {
    const data = mint(GEN2_RUN);
    expect(data.id).toHaveLength(26);
    expect(data.id[24]).toBe("a");
    expect(data.id[25]).toBe("2");
    expect(data.friendlyId).toBe(`waitpoint_${data.id}`);
  });

  it("a gen-1 run anchor keeps a cuid", () => {
    expect(mint(GEN1_RUN).id).toHaveLength(25);
  });

  it("mints a fresh core, so the waitpoint id never equals the run's own body", () => {
    expect(mint(GEN2_RUN).id).not.toBe(GEN2_RUN);
  });

  it("a batch anchor stamps the batch's shard", () => {
    // The create names only completedByBatchId, so that is what the router validates against.
    expect(mint(GEN2_BATCH).id[24]).toBe("b");
  });
});

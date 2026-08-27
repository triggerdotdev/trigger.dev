import { getMeter } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { Waitpoint } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { UnclassifiableWaitpointId } from "../errors.js";
import { WaitpointRouterCoordinator } from "./routerCoordinator.js";
import type { CompletionEnvelopeSource, RunBlockEdge, WaitpointCoordinator } from "./types.js";

const LEGACY_ID = "waitpoint_ckabc123def456ghi789jkl";
const logger = new Logger("routerCoordinator.test", "error");

function storeId() {
  return generateWaitpointId("MANUAL");
}

/**
 * A recording double, not a mock: a real object satisfying the seam that remembers what it
 * was asked. The router's whole job is dispatch, so what each arm receives IS the assertion.
 */
function arm(name: string, calls: string[], overrides: Partial<WaitpointCoordinator> = {}) {
  const base: WaitpointCoordinator = {
    async clearRunBlockState(params) {
      calls.push(`${name}.clearRunBlockState:${JSON.stringify(params.edgeIds ?? null)}`);
      return { count: params.edgeIds?.length ?? 0 };
    },
    async readRunBlockState(runId) {
      calls.push(`${name}.readRunBlockState`);
      return [];
    },
    async readCompletionEnvelopes(params) {
      calls.push(`${name}.readCompletionEnvelopes:${params.waitpointIds.length}`);
      return [];
    },
    async registerBlocks(params) {
      calls.push(`${name}.registerBlocks:${params.waitpointIds.length}`);
      return { pendingCount: 0 };
    },
    async registerBlocksLockless(params) {
      calls.push(`${name}.registerBlocksLockless:${params.waitpointIds.length}`);
    },
    async complete(params) {
      calls.push(`${name}.complete`);
      return { waitpoint: { id: params.waitpointId } as Waitpoint, blockedRuns: [] };
    },
    async createDateTimeWaitpoint() {
      calls.push(`${name}.createDateTimeWaitpoint`);
      return { kind: "created", waitpoint: {} as Waitpoint };
    },
    async createManualWaitpoint() {
      calls.push(`${name}.createManualWaitpoint`);
      return { kind: "created", waitpoint: {} as Waitpoint };
    },
    async createBatchWaitpoint() {
      calls.push(`${name}.createBatchWaitpoint`);
      return {} as Waitpoint;
    },
    mintAssociatedWaitpointData() {
      calls.push(`${name}.mintAssociatedWaitpointData`);
      return {} as never;
    },
    async createAssociatedWaitpoint(params) {
      calls.push(`${name}.createAssociatedWaitpoint`);
      return { id: params.data.id } as Waitpoint;
    },
  };

  return { ...base, ...overrides };
}

function router(calls: string[], opts: { withStore?: boolean } = { withStore: true }) {
  return new WaitpointRouterCoordinator({
    legacy: arm("legacy", calls),
    store: opts.withStore ? arm("store", calls) : undefined,
    logger,
    meter: getMeter("routerCoordinator.test"),
  });
}

describe("WaitpointRouterCoordinator", () => {
  describe("routing an operation by id shape", () => {
    it("sends a legacy id to the legacy arm", async () => {
      const calls: string[] = [];
      await router(calls).complete({ waitpointId: LEGACY_ID });
      expect(calls).toEqual(["legacy.complete"]);
    });

    it("sends a store id to the store arm", async () => {
      const calls: string[] = [];
      await router(calls).complete({ waitpointId: storeId() });
      expect(calls).toEqual(["store.complete"]);
    });

    it("throws on a store id when no store arm is configured", async () => {
      const calls: string[] = [];
      await expect(
        router(calls, { withStore: false }).complete({ waitpointId: storeId() })
      ).rejects.toBeInstanceOf(UnclassifiableWaitpointId);
      expect(calls).toEqual([]);
    });
  });

  describe("fanning a mixed run across both arms", () => {
    it("concatenates readRunBlockState from both", async () => {
      const calls: string[] = [];
      const legacyEdge = { id: "edge_legacy" } as RunBlockEdge;
      const storeEdge = { id: "edge_store" } as RunBlockEdge;
      const coordinator = new WaitpointRouterCoordinator({
        legacy: arm("legacy", calls, { readRunBlockState: async () => [legacyEdge] }),
        store: arm("store", calls, { readRunBlockState: async () => [storeEdge] }),
        logger,
        meter: getMeter("routerCoordinator.test"),
      });

      const edges = await coordinator.readRunBlockState("run_1");

      expect(edges.map((e) => e.id)).toEqual(["edge_legacy", "edge_store"]);
    });

    it("sums the pending count across both arms", async () => {
      const calls: string[] = [];
      const coordinator = new WaitpointRouterCoordinator({
        legacy: arm("legacy", calls, { registerBlocks: async () => ({ pendingCount: 1 }) }),
        store: arm("store", calls, { registerBlocks: async () => ({ pendingCount: 2 }) }),
        logger,
        meter: getMeter("routerCoordinator.test"),
      });

      const { pendingCount } = await coordinator.registerBlocks({
        runId: "run_1",
        waitpointIds: [LEGACY_ID, storeId()],
        projectId: "proj_1",
        client: {} as never,
      });

      expect(pendingCount).toBe(3);
    });

    it("gives each arm only the ids it owns", async () => {
      const calls: string[] = [];
      await router(calls).registerBlocks({
        runId: "run_1",
        waitpointIds: [LEGACY_ID, storeId(), storeId()],
        projectId: "proj_1",
        client: {} as never,
      });

      expect(calls.sort()).toEqual(["legacy.registerBlocks:1", "store.registerBlocks:2"]);
    });

    it("concatenates completion envelopes from both arms", async () => {
      const calls: string[] = [];
      const coordinator = new WaitpointRouterCoordinator({
        legacy: arm("legacy", calls, {
          readCompletionEnvelopes: async () => [{ id: "a" } as CompletionEnvelopeSource],
        }),
        store: arm("store", calls, {
          readCompletionEnvelopes: async () => [{ id: "b" } as CompletionEnvelopeSource],
        }),
        logger,
        meter: getMeter("routerCoordinator.test"),
      });

      const sources = await coordinator.readCompletionEnvelopes({
        runId: "run_1",
        waitpointIds: [LEGACY_ID, storeId()],
      });

      expect(sources.map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("skips an arm that owns none of the requested ids", async () => {
      const calls: string[] = [];
      await router(calls).registerBlocks({
        runId: "run_1",
        waitpointIds: [LEGACY_ID],
        projectId: "proj_1",
        client: {} as never,
      });

      expect(calls).toEqual(["legacy.registerBlocks:1"]);
    });
  });

  describe("clearing block state", () => {
    // The trap this pins: an omitted edgeIds means "clear the whole run", so a partition
    // that comes out empty must send [] and never omit, or it wipes the other arm's edges.
    it("sends an empty array, never an omission, to the arm with no edges", async () => {
      const calls: string[] = [];
      await router(calls).clearRunBlockState({ runId: "run_1", edgeIds: ["ckLegacyEdgeId"] });

      expect(calls.sort()).toEqual([
        'legacy.clearRunBlockState:["ckLegacyEdgeId"]',
        "store.clearRunBlockState:[]",
      ]);
    });

    it("routes a store edge id by the waitpoint id it carries", async () => {
      const calls: string[] = [];
      const edgeId = `${storeId()}#0`;
      await router(calls).clearRunBlockState({ runId: "run_1", edgeIds: [edgeId] });

      expect(calls.sort()).toEqual([
        "legacy.clearRunBlockState:[]",
        `store.clearRunBlockState:["${edgeId}"]`,
      ]);
    });

    it("forwards a full clear to both arms with edgeIds omitted", async () => {
      const calls: string[] = [];
      await router(calls).clearRunBlockState({ runId: "run_1" });

      expect(calls.sort()).toEqual([
        "legacy.clearRunBlockState:null",
        "store.clearRunBlockState:null",
      ]);
    });

    it("sums the cleared counts", async () => {
      const calls: string[] = [];
      const { count } = await router(calls).clearRunBlockState({
        runId: "run_1",
        edgeIds: ["ckLegacyEdgeId", `${storeId()}#0`],
      });

      expect(count).toBe(2);
    });
  });

  describe("routing a create by mint kind", () => {
    it("sends a legacy mint to the legacy arm", async () => {
      const calls: string[] = [];
      await router(calls).createManualWaitpoint({
        mintKind: "legacy",
        environmentId: "env_1",
        projectId: "proj_1",
      });

      expect(calls).toEqual(["legacy.createManualWaitpoint"]);
    });

    it("sends a store mint to the store arm", async () => {
      const calls: string[] = [];
      await router(calls).createManualWaitpoint({
        mintKind: "store",
        environmentId: "env_1",
        projectId: "proj_1",
      });

      expect(calls).toEqual(["store.createManualWaitpoint"]);
    });

    // Fail safe at the mint, unlike an operation on an existing id: a misconfigured deploy
    // must not fail every trigger for a flipped organization.
    it("falls back to legacy when a store mint finds no store arm", async () => {
      const calls: string[] = [];
      await router(calls, { withStore: false }).createManualWaitpoint({
        mintKind: "store",
        environmentId: "env_1",
        projectId: "proj_1",
      });

      expect(calls).toEqual(["legacy.createManualWaitpoint"]);
    });
  });

  describe("routing an associated waitpoint", () => {
    it("routes createAssociatedWaitpoint by the shape of the minted id", async () => {
      const calls: string[] = [];
      const id = storeId();
      await router(calls).createAssociatedWaitpoint({
        runId: "run_1",
        data: { id } as never,
      });

      expect(calls).toEqual(["store.createAssociatedWaitpoint"]);
    });
  });
});

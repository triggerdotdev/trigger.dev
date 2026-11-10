// Real MemoryDB (testcontainer) coverage for the RUN and DATETIME store mint + association-discovery
// this ticket wires onto the StoreWaitpointCoordinator adapter. redisTest FLUSHALLs before each test.
import { type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  parseWaitpointId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";

function makeAdapter(redisOptions: RedisOptions) {
  const store = new WaitpointStoreCoordinator({ redisOptions });
  const adapter = new StoreWaitpointCoordinator({ store });
  return { store, adapter };
}

describe("StoreWaitpointCoordinator DATETIME mint", () => {
  redisTest(
    "creates a store-format DATETIME record with its deadline",
    async ({ redisOptions }) => {
      const { store, adapter } = makeAdapter(redisOptions);
      try {
        const completedAfter = new Date("2027-01-01T00:00:00.000Z");
        const result = await adapter.createDateTimeWaitpoint({
          projectId: "proj_1",
          environmentId: "env_1",
          completedAfter,
        });

        expect(result.kind).toBe("created");
        expect(parseWaitpointId(result.waitpoint.id)).toMatchObject({
          format: "b32hexW",
          type: "DATETIME",
        });
        expect(result.waitpoint.completedAfter?.toISOString()).toBe(completedAfter.toISOString());
        expect(await store.probeWaitpointPresence(result.waitpoint.id)).toBe("present");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "reuses a live DATETIME key and mints a fresh identity after expiry",
    async ({ redisOptions }) => {
      const { store, adapter } = makeAdapter(redisOptions);
      try {
        const params = {
          projectId: "proj_1",
          environmentId: "env_1",
          completedAfter: new Date("2027-01-01T00:00:00.000Z"),
          idempotencyKey: "idem-a",
        };
        const first = await adapter.createDateTimeWaitpoint(params);
        const second = await adapter.createDateTimeWaitpoint(params);

        expect(first.kind).toBe("created");
        expect(second.kind).toBe("cached");
        expect(second.waitpoint.id).toBe(first.waitpoint.id);

        const base = {
          projectId: "proj_1",
          environmentId: "env_1",
          completedAfter: new Date("2027-01-01T00:00:00.000Z"),
          idempotencyKey: "idem-exp",
        };
        const expired = await adapter.createDateTimeWaitpoint({
          ...base,
          idempotencyKeyExpiresAt: new Date(Date.now() - 1000),
        });
        const fresh = await adapter.createDateTimeWaitpoint(base);

        expect(fresh.waitpoint.id).not.toBe(expired.waitpoint.id);
        expect(fresh.kind).toBe("created");
      } finally {
        await store.quit();
      }
    }
  );
});

describe("StoreWaitpointCoordinator RUN mint + association discovery", () => {
  redisTest(
    "derives a deterministic id from the child run and is idempotent",
    async ({ redisOptions }) => {
      const { store, adapter } = makeAdapter(redisOptions);
      try {
        const anchorRunId = `run_${generateRunOpsId()}`;
        const derived = deriveWaitpointIdFromAnchor(anchorRunId, "RUN");
        expect(derived).toBeDefined();

        expect(await adapter.findAssociatedRunWaitpointId(anchorRunId)).toBeUndefined();
        const data = adapter.mintAssociatedWaitpointData({
          projectId: "proj_1",
          environmentId: "env_1",
          anchorRunId,
        });
        expect(data.id).toBe(derived);
        expect(data.friendlyId).toBe(WaitpointId.toFriendlyId(derived!));
        expect(data.type).toBe("RUN");

        const w1 = await adapter.createAssociatedWaitpoint({ runId: anchorRunId, data });
        const w2 = await adapter.createAssociatedWaitpoint({ runId: anchorRunId, data });
        expect(w1.id).toBe(data.id);
        expect(w2.id).toBe(data.id);
        expect(await store.probeWaitpointPresence(data.id)).toBe("present");
        expect(await adapter.findAssociatedRunWaitpointId(anchorRunId)).toBe(data.id);
        for (const mismatch of [
          { runId: "another-child", data },
          { runId: anchorRunId, data: { ...data, projectId: "another-project" } },
          { runId: anchorRunId, data: { ...data, environmentId: "another-environment" } },
        ]) {
          await expect(adapter.createAssociatedWaitpoint(mismatch)).rejects.toThrow(
            "ownership conflict"
          );
        }
      } finally {
        await store.quit();
      }
    }
  );
});

describe("StoreWaitpointCoordinator association discovery: absence vs failure", () => {
  redisTest(
    "a confirmed-absent record is undefined; a Redis failure throws",
    async ({ redisOptions }) => {
      const okStore = new WaitpointStoreCoordinator({ redisOptions });
      const okAdapter = new StoreWaitpointCoordinator({ store: okStore });
      const unavailableStore = new WaitpointStoreCoordinator({ redisOptions });
      const throwingAdapter = new StoreWaitpointCoordinator({ store: unavailableStore });
      try {
        const anchorRunId = `run_${generateRunOpsId()}`;
        // Absent → undefined, never an error.
        expect(await okAdapter.findAssociatedRunWaitpointId(anchorRunId)).toBeUndefined();
        expect(await okAdapter.readAssociatedRunWaitpoint(anchorRunId)).toBeUndefined();
        // A closed real client must fail, never report a missing association.
        await unavailableStore.quit();
        await expect(throwingAdapter.findAssociatedRunWaitpointId(anchorRunId)).rejects.toThrow(
          /closed|ended/i
        );
        await expect(throwingAdapter.readAssociatedRunWaitpoint(anchorRunId)).rejects.toThrow(
          /closed|ended/i
        );
      } finally {
        await okStore.quit();
        await unavailableStore.quit();
      }
    }
  );
});

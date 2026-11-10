import { containerTest } from "@internal/testcontainers";
import { generateRunOpsId, parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";

import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { context, routing } from "../tests/utils/waitpointRouting.js";

describe("RoutingWaitpointCoordinator persisted boundaries", () => {
  containerTest(
    "associated RUN planning ignores snapshot residency and defaults to legacy without context",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const coordinator = routing(prisma, store);
        const params = { ...(await context(prisma)), anchorRunId: generateRunOpsId() };
        const enabled = await coordinator.planAssociatedWaitpoint(params);
        const postgres = await coordinator.planAssociatedWaitpoint({
          ...params,
          mintContext: { ...params.mintContext, parentResidency: "postgres" },
        });
        const absent = await coordinator.planAssociatedWaitpoint({
          ...params,
          mintContext: undefined,
        });
        expect(enabled.residency).toBe("store");
        expect(parseWaitpointId(enabled.data.id).format).toBe("b32hexW");
        expect(postgres.residency).toBe("store");
        expect(postgres.data.id).toBe(enabled.data.id);
        expect(absent.residency).toBe("legacy");
        expect(parseWaitpointId(absent.data.id).format).toBe("legacy");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "rollback still discovers the real store RUN association",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const params = await context(prisma);
        const runId = generateRunOpsId();
        const adapter = new StoreWaitpointCoordinator({ store });
        const data = adapter.mintAssociatedWaitpointData({ ...params, anchorRunId: runId });
        await adapter.createAssociatedWaitpoint({ runId, data });
        const coordinator = routing(prisma, store, {
          mintPolicy: { resolveMintMode: () => "legacy", isCapabilityReady: () => true },
        });
        expect(await coordinator.findAssociatedRunWaitpointId(runId)).toBe(data.id);
      } finally {
        await store.quit();
      }
    }
  );
});

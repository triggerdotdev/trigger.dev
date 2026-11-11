import { describe, expect } from "vitest";
import { PrismaClient } from "@trigger.dev/database";
import { waitpointKeyTransactionLaneForClient } from "@internal/run-store";
import { signalsEmitter } from "~/services/signals.server";
import { registerWaitpointKeyWriter } from "~/v3/waitpointKeyTransactionLane.server";
import { postgresTest } from "@internal/testcontainers";
import { createWaitpointStoreEnabledResolver } from "~/v3/utils/waitpointStoreEnabled.server";

describe("waitpoint rollout", () => {
  postgresTest(
    "waitpoint enrollment uses ordinary org flags, global fallback, and immediate rollback",
    async ({ prisma }) => {
      const org = await prisma.organization.create({
        data: { title: "Waitpoints", slug: "waitpoints" },
      });
      let global: { waitpointStoreEnabled?: boolean } | undefined;
      const enabled = createWaitpointStoreEnabledResolver(() => global, prisma);
      expect(await enabled(org.id)).toBe(false);
      await prisma.organization.update({
        where: { id: org.id },
        data: { featureFlags: { waitpointStoreEnabled: true } },
      });
      expect(await enabled(org.id)).toBe(true);
      global = { waitpointStoreEnabled: false };
      expect(await enabled(org.id)).toBe(true);
      await prisma.organization.update({
        where: { id: org.id },
        data: { featureFlags: { waitpointStoreEnabled: false } },
      });
      global = { waitpointStoreEnabled: true };
      expect(await enabled(org.id)).toBe(false);
      expect(await enabled(org.id, {})).toBe(true);
      expect(await enabled(org.id, { waitpointStoreEnabled: false })).toBe(false);
      global = { waitpointStoreEnabled: false };
      expect(await enabled(org.id)).toBe(false);
      expect(await prisma.featureFlag.count()).toBe(0);
    }
  );

  postgresTest(
    "active and queued key transactions remain available while HTTP drains after process signals",
    async ({ postgresContainer }) => {
      const writer = registerWaitpointKeyWriter(
        {},
        postgresContainer.getConnectionUri(),
        (isolatedUrl) => new PrismaClient({ datasources: { db: { url: isolatedUrl } } })
      );
      const lane = waitpointKeyTransactionLaneForClient(writer)!;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const active = lane.run("draining-org", Date.now() + 5_000, async (tx) => {
        entered = true;
        await barrier;
        return tx.$queryRaw<{ value: number }[]>`SELECT 1 AS value`;
      });
      let queued: Promise<unknown> | undefined;
      try {
        await expect
          .poll(() => entered, {
            timeout: 2_000,
            interval: 20,
            message: "first key transaction never entered",
          })
          .toBe(true);
        queued = lane.run(
          "draining-org",
          Date.now() + 5_000,
          (tx) => tx.$queryRaw<{ value: number }[]>`SELECT 2 AS value`
        );
        const settled = Promise.allSettled([active, queued]);
        signalsEmitter.emit("SIGTERM", { signal: "SIGTERM", time: new Date() });
        signalsEmitter.emit("SIGINT", { signal: "SIGINT", time: new Date() });
        release();
        expect(await settled).toEqual([
          { status: "fulfilled", value: [{ value: 1 }] },
          { status: "fulfilled", value: [{ value: 2 }] },
        ]);
        // An already accepted HTTP request may first need the lane during the drain.
        await expect(
          lane.run(
            "later-org",
            Date.now() + 5_000,
            (tx) => tx.$queryRaw<{ value: number }[]>`SELECT 3 AS value`
          )
        ).resolves.toEqual([{ value: 3 }]);
      } finally {
        release();
        await Promise.allSettled([active, ...(queued ? [queued] : [])]);
        await lane.close();
      }
      await expect(
        lane.run("later-org", Date.now() + 5_000, async () => undefined)
      ).rejects.toThrow("Waitpoint key transaction lane is closed");
    }
  );
});

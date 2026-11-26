import { describe, expect, test } from "vitest";
import { type Prisma, PrismaClient } from "@trigger.dev/database";
import { waitpointKeyTransactionLaneForClient } from "@internal/run-store";
import { signalsEmitter } from "~/services/signals.server";
import { registerWaitpointKeyWriter } from "~/v3/waitpointKeyTransactionLane.server";
import { postgresTest } from "@internal/testcontainers";
import { createCheckpointStoreEnabledResolver } from "~/v3/utils/checkpointStoreEnabled.server";
import {
  createWaitpointStoreEnabledResolver,
  waitpointStoreStandaloneTokensEnabled,
} from "~/v3/utils/waitpointStoreEnabled.server";

describe("waitpoint rollout", () => {
  // Catches: standalone tokens following the store flag instead of their own.
  test("standalone tokens use their own flag: org override, then global, then off", () => {
    const enabled = waitpointStoreStandaloneTokensEnabled;
    expect(enabled({ waitpointStoreEnabled: true }, undefined)).toBe(false);
    expect(enabled({}, { waitpointStoreStandaloneTokens: true })).toBe(true);
    expect(
      enabled({ waitpointStoreStandaloneTokens: false }, { waitpointStoreStandaloneTokens: true })
    ).toBe(false);
    expect(enabled({ waitpointStoreStandaloneTokens: true }, undefined)).toBe(true);
    expect(enabled({ waitpointStoreStandaloneTokens: "true" }, undefined)).toBe(false);
    expect(enabled(null, undefined)).toBe(false);
  });

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

describe("checkpoint store rollout", () => {
  // Catches: the checkpoint flag read from another key, coerced from a string, turned on by the
  // waitpoint flag or the snapshot store setting, or resolved with more than one read.
  postgresTest(
    "the checkpoint flag uses ordinary org flags and global fallback, and no other flag turns it on",
    async ({ prisma }) => {
      const org = await prisma.organization.create({
        data: { title: "Checkpoints", slug: "checkpoints" },
      });
      let findFirst = 0;
      const client = {
        organization: {
          findFirst: (args: unknown) => {
            findFirst++;
            return (prisma.organization.findFirst as (a: unknown) => unknown)(args);
          },
        },
      } as unknown as Pick<PrismaClient, "organization">;
      let global: { checkpointStoreEnabled?: boolean } | undefined;
      const resolve = createCheckpointStoreEnabledResolver(() => global, client);
      let calls = 0;
      const enabled = () => {
        calls++;
        return resolve(org.id);
      };
      const setFlags = (featureFlags: Prisma.InputJsonValue) =>
        prisma.organization.update({ where: { id: org.id }, data: { featureFlags } });

      expect(await enabled()).toBe(false);
      await setFlags({ checkpointStoreEnabled: true });
      expect(await enabled()).toBe(true);
      global = { checkpointStoreEnabled: false };
      expect(await enabled()).toBe(true);
      await setFlags({ checkpointStoreEnabled: false });
      global = { checkpointStoreEnabled: true };
      expect(await enabled()).toBe(false);
      await setFlags({});
      expect(await enabled()).toBe(true);
      await setFlags({ checkpointStoreEnabled: "true" });
      global = { checkpointStoreEnabled: false };
      expect(await enabled()).toBe(false);

      global = undefined;
      for (const flags of [
        { snapshotStoreMode: "off" },
        { snapshotStoreMode: "dual-write" },
        { snapshotStoreMode: "redis-read" },
        { snapshotStoreMode: "redis-only" },
        { waitpointStoreEnabled: true },
        { waitpointStoreEnabled: true, snapshotStoreMode: "redis-only" },
      ]) {
        await setFlags(flags);
        expect(await enabled(), JSON.stringify(flags)).toBe(false);
      }
      expect(findFirst).toBe(calls);
      expect(await prisma.featureFlag.count()).toBe(0);
    }
  );

  // Catches: the resolver reading another organisation's flags (a lookup not filtered by id).
  postgresTest(
    "the checkpoint flag of each organisation is read from that organisation",
    async ({ prisma }) => {
      const first = await prisma.organization.create({
        data: { title: "Checkpoints A", slug: "checkpoints-a" },
      });
      const second = await prisma.organization.create({
        data: { title: "Checkpoints B", slug: "checkpoints-b" },
      });
      const resolve = createCheckpointStoreEnabledResolver(() => undefined, prisma);
      const setFlag = (id: string, checkpointStoreEnabled: boolean) =>
        prisma.organization.update({
          where: { id },
          data: { featureFlags: { checkpointStoreEnabled } },
        });

      for (const firstOn of [true, false]) {
        await setFlag(first.id, firstOn);
        await setFlag(second.id, !firstOn);
        expect(await resolve(first.id), `first, set ${firstOn}`).toBe(firstOn);
        expect(await resolve(second.id), `second, set ${!firstOn}`).toBe(!firstOn);
      }
    }
  );
});

import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { LOGS_SEARCH_PROJECTOR_STATE_ID } from "~/services/logsSearchProjector.server";
import { PrismaLogsSearchProjectorStateStore } from "~/services/logsSearchProjectorStateStore.server";

const at = (value: string) => new Date(value);

postgresTest(
  "persists projector leases, watermarks, pause state, and backfill state",
  async ({ prisma }) => {
    const store = new PrismaLogsSearchProjectorStateStore(prisma);
    const initial = at("2026-08-14T12:00:00.000Z");
    const next = at("2026-08-14T12:01:00.000Z");

    await expect(store.find()).resolves.toBeNull();
    await expect(store.initialize(initial)).resolves.toMatchObject({
      id: LOGS_SEARCH_PROJECTOR_STATE_ID,
      liveWatermark: initial,
      historicalWatermark: initial,
      paused: false,
    });

    expect(await store.acquireLease("lease-a", 60_000)).toBe(true);
    expect(await store.acquireLease("lease-b", 60_000)).toBe(false);
    expect(await store.advanceLive("lease-a", next, at("2026-08-14T12:02:00.000Z"))).toBe(false);
    expect(await store.advanceLive("lease-a", initial, next)).toBe(true);
    await store.releaseLease("lease-a");

    await store.pause();
    expect(await store.acquireLease("lease-b", 60_000)).toBe(false);
    await store.resume();
    expect(await store.acquireLease("lease-b", 60_000)).toBe(true);

    const target = at("2026-08-14T11:58:00.000Z");
    expect(await store.setBackfillTarget(initial, target)).toBe(true);
    expect(await store.advanceHistorical("lease-b", next, initial, target)).toBe(false);
    expect(
      await store.advanceHistorical("lease-b", initial, at("2026-08-14T11:59:00.000Z"), target)
    ).toBe(true);
    expect(
      await store.advanceHistorical("lease-b", at("2026-08-14T11:59:00.000Z"), target, target)
    ).toBe(true);

    await expect(store.get()).resolves.toMatchObject({
      liveWatermark: next,
      historicalWatermark: target,
      backfillTarget: null,
      paused: false,
      leaseToken: "lease-b",
    });
  }
);

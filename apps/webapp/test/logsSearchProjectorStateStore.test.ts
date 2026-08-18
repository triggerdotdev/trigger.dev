import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import {
  LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
  LOGS_SEARCH_PROJECTOR_ID,
  LOGS_SEARCH_PROJECTOR_INITIAL_MODE,
  type LogsSearchProjectorWindow,
} from "~/services/logsSearchProjector.server";
import { PrismaLogsSearchProjectorStateStore } from "~/services/logsSearchProjectorStateStore.server";

const at = (value: string) => new Date(value);

postgresTest(
  "persists append-only initialization and finalized checkpoints",
  { timeout: 20_000 },
  async ({ prisma }) => {
    const store = new PrismaLogsSearchProjectorStateStore(prisma);
    const initial = at("2026-08-14T12:00:00.000Z");
    const laterInitialization = at("2026-08-14T12:05:00.000Z");
    const window: LogsSearchProjectorWindow = {
      mode: "finalized",
      start: initial,
      end: at("2026-08-14T12:01:00.000Z"),
    };

    await expect(store.findInitialWatermark()).resolves.toBeNull();
    await expect(store.initialize(initial)).resolves.toEqual(initial);
    await expect(store.initialize(laterInitialization)).resolves.toEqual(initial);
    await expect(store.getFinalizedWatermark(initial)).resolves.toEqual(initial);

    await expect(
      store.appendFinalizedCheckpoint(window, {
        queryId: "query-1",
        readRows: 10,
        writtenRows: 8,
      })
    ).resolves.toBe("inserted");
    await expect(
      store.appendFinalizedCheckpoint(window, {
        queryId: "query-retry",
        readRows: 10,
        writtenRows: 8,
      })
    ).resolves.toBe("duplicate");
    await expect(store.getFinalizedWatermark(initial)).resolves.toEqual(window.end);

    const checkpoints = await prisma.logsSearchProjectorCheckpoint.findMany({
      where: { projectorId: LOGS_SEARCH_PROJECTOR_ID },
      orderBy: { windowEnd: "asc" },
    });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints).toEqual([
      expect.objectContaining({
        mode: LOGS_SEARCH_PROJECTOR_INITIAL_MODE,
        windowStart: initial,
        windowEnd: initial,
        queryId: null,
      }),
      expect.objectContaining({
        mode: LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
        windowStart: window.start,
        windowEnd: window.end,
        queryId: "query-1",
      }),
    ]);
  }
);

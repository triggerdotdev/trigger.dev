import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import {
  LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
  LOGS_SEARCH_PROJECTOR_ID,
  type LogsSearchProjectorWindow,
} from "~/services/logsSearchProjector.server";
import { PrismaLogsSearchProjectorStateStore } from "~/services/logsSearchProjectorStateStore.server";

const at = (value: string) => new Date(value);

postgresTest(
  "persists low-churn control state and append-only finalized checkpoints",
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

    await expect(store.findControl()).resolves.toBeNull();
    await expect(store.initialize(initial)).resolves.toMatchObject({
      id: LOGS_SEARCH_PROJECTOR_ID,
      initialWatermark: initial,
      paused: false,
    });
    await expect(store.initialize(laterInitialization)).resolves.toMatchObject({
      initialWatermark: initial,
    });
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

    expect(
      await prisma.logsSearchProjectorCheckpoint.findMany({
        where: {
          projectorId: LOGS_SEARCH_PROJECTOR_ID,
          mode: LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
        },
      })
    ).toHaveLength(1);

    const controlBeforePause = await prisma.logsSearchProjectorControl.findFirst({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
    });
    await store.pause();
    await expect(store.getControl()).resolves.toMatchObject({ paused: true });
    await store.resume();
    await expect(store.getControl()).resolves.toMatchObject({ paused: false });

    const controlAfterResume = await prisma.logsSearchProjectorControl.findFirst({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
    });
    expect(controlAfterResume?.initialWatermark).toEqual(initial);
    expect(controlAfterResume?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      controlBeforePause!.updatedAt.getTime()
    );
  }
);

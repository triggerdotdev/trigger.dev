import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import type { TaskRun } from "@trigger.dev/database";
import seedrandom from "seedrandom";
import { describe, expect, vi } from "vitest";
import type { RunEngine } from "../index.js";
import { triggerRun } from "./utils/storeRunWaitpointLifecycleFixtures.js";
import {
  attachCachedRun,
  createFailedItem,
  deliverItem,
  expectBatchResolvedOnce,
  itemPayload,
  newFriendlyId,
  setupBatchParent,
  storeBatchHarness,
  triggerItem,
  type FaultMode,
  type StoreBatchHarness,
} from "./utils/storeBatchHarness.js";

vi.setConfig({ testTimeout: 900_000 });

/** "cachedLegacy"/"cachedStore" attach an existing keyed run with a Postgres or store RUN waitpoint. */
type ItemKind = "plain" | "cachedLegacy" | "cachedStore" | "debounce";
type Fault = { at: number; mode: FaultMode; from?: boolean };
type Case = {
  items: ItemKind[];
  order?: number[];
  fault?: Fault;
  lateRecovery?: boolean;
  /** The BatchQueue delivers this index a second time after the batch's first pass. */
  redeliver?: number;
};

/** One batch through the real engines; returns how many producer store commands it issued. */
async function runCase(h: StoreBatchHarness, c: Case): Promise<number> {
  const { engine, env, prisma } = h;
  h.faults.disarm();
  const b = await setupBatchParent(h, c.items.length);
  const cached = new Map<number, TaskRun>();
  for (const [index, kind] of c.items.entries()) {
    if (kind !== "cachedLegacy" && kind !== "cachedStore") continue;
    const run = await triggerRun(engine, env, prisma, {
      friendlyId: newFriendlyId(),
      taskIdentifier: "child-task",
      idempotencyKey: `key-${b.batchId}-${index}`,
      payload: itemPayload(index),
    });
    if (kind === "cachedLegacy")
      await engine.getOrCreateRunWaitpoint({
        runId: run.id,
        projectId: env.project.id,
        environmentId: env.id,
      });
    cached.set(index, run);
  }
  const attempt = (index: number) => (on: RunEngine) => {
    switch (c.items[index]) {
      case "plain":
        return triggerItem(h, on, b, index);
      case "debounce":
        return triggerItem(h, on, b, index, {
          debounce: { key: `debounce-${b.batchId}`, delay: "1s" },
          delayUntil: new Date(Date.now() + 1000),
        });
      default:
        return attachCachedRun(h, on, b, index, cached.get(index)!);
    }
  };

  h.faults.arm(c.fault ?? { at: 0, mode: "throw" });
  const order = [
    ...(c.order ?? c.items.keys()),
    ...(c.redeliver !== undefined ? [c.redeliver] : []),
  ];
  for (const index of order)
    await deliverItem(h, attempt(index), (on) => createFailedItem(h, on, b, index));
  const commands = h.faults.commands;
  h.faults.disarm();
  await expectBatchResolvedOnce(h, b, {
    lateRecovery: c.lateRecovery,
    extraRunIds: [...cached.values()].map((r) => r.id),
  });
  return commands;
}

// Every command locally, every fifth in CI. STORE_BATCH_MODEL_STRIDE overrides; STORE_BATCH_MODEL_AT
// replays one command.
const STRIDE = Number(process.env.STORE_BATCH_MODEL_STRIDE ?? (process.env.CI ? 5 : 1));
const ONLY_AT = process.env.STORE_BATCH_MODEL_AT
  ? Number(process.env.STORE_BATCH_MODEL_AT)
  : undefined;

const modes: { mode: FaultMode; stallTimeoutMs?: number }[] = [
  { mode: "throw", stallTimeoutMs: 10_000 },
  { mode: "replyLost" },
  { mode: "stall", stallTimeoutMs: 30_000 },
];

describe("store batchTriggerAndWait under one failed store command", () => {
  for (const { mode, stallTimeoutMs } of modes)
    // Catches: any single producer store fault that loses, duplicates or misplaces an item's result.
    containerTest(
      `every producer command, one at a time: ${mode}`,
      async ({ prisma, redisOptions }) => {
        const c: Case = { items: ["plain", "cachedLegacy", "cachedStore"], redeliver: 0 };
        let env: StoreBatchHarness["env"] | undefined;
        const run = async (fault?: Fault) => {
          const h = await storeBatchHarness(prisma, redisOptions, { stallTimeoutMs, env });
          env = h.env;
          try {
            const commands = await runCase(h, { ...c, fault });
            if (fault) expect(h.faults.fired, "the fault never fired").toBe(true);
            return commands;
          } catch (error) {
            throw new Error(`${JSON.stringify({ ...c, fault })}: ${String(error)}`, {
              cause: error,
            });
          } finally {
            await h.close();
          }
        };
        const commands = await run();
        expect(commands, "a clean batch issued no store commands").toBeGreaterThan(0);
        for (let at = ONLY_AT ?? 1; at <= (ONLY_AT ?? commands); at += STRIDE)
          await run({ at, mode });
      }
    );
});

// Nightly: STORE_BATCH_MODEL_SEEDS=200. STORE_BATCH_MODEL_SEED replays one.
const SEEDS = Number(process.env.STORE_BATCH_MODEL_SEEDS ?? 20);
const ONLY_SEED = process.env.STORE_BATCH_MODEL_SEED
  ? Number(process.env.STORE_BATCH_MODEL_SEED)
  : undefined;
const kinds: ItemKind[] = ["plain", "cachedLegacy", "cachedStore", "debounce"];

function randomCase(seed: string): Case & { mode: FaultMode } {
  const random = seedrandom(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  // Every fifth schedule is a larger batch.
  const count = Number(seed.split("-").at(-1)) % 5 === 0 ? 10 : 3;
  const items = Array.from({ length: count }, () => pick(kinds));
  // One debounce key per batch: a second debounced item would share the first one's run.
  const seen = items.indexOf("debounce");
  for (let i = seen + 1; seen >= 0 && i < count; i++)
    if (items[i] === "debounce") items[i] = "plain";
  const order = [...items.keys()].sort(() => random() - 0.5);
  const mode = pick(["throw", "replyLost", "stall"] as const);
  // A producer that dies outright leaves its child to recovery.
  const from = mode === "throw" && random() < 0.3;
  const lateRecovery = !from && random() < 0.4;
  const redeliver = random() < 0.3 ? Math.floor(random() * count) : undefined;
  return {
    items,
    order,
    mode,
    lateRecovery,
    redeliver,
    fault: { at: 1 + Math.floor(random() * count * 13), mode, from },
  };
}

describe("store batchTriggerAndWait under seeded fault schedules", () => {
  // Catches: a fault schedule the single-fault sweep does not reach (order, death, timing).
  containerTest(`${SEEDS} seeded schedules`, async ({ prisma, redisOptions }) => {
    let env: StoreBatchHarness["env"] | undefined;
    for (let seed = ONLY_SEED ?? 1; seed <= (ONLY_SEED ?? SEEDS); seed++) {
      const c = randomCase(`batch-model-${seed}`);
      const h = await storeBatchHarness(prisma, redisOptions, {
        stallTimeoutMs: c.mode === "replyLost" ? undefined : 30_000,
        recoveryDelayMs: c.lateRecovery ? 600_000 : 200,
        env,
      });
      env = h.env;
      try {
        await runCase(h, c);
      } catch (error) {
        throw new Error(`seed ${seed} ${JSON.stringify(c)}: ${String(error)}`, { cause: error });
      } finally {
        await h.close();
      }
    }
  });
});

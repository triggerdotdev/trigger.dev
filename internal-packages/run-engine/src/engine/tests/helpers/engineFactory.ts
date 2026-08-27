import type { RedisOptions } from "@internal/redis";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";
import { toPrismaWaitpoint } from "../../waitpointCoordinator/waitpointShape.js";
import { generateRunOpsId, parseWaitpointId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "../../index.js";
import type { RunEngineOptions } from "../../types.js";

/** Which waitpoint coordinator the engine under test routes through. */
export type WaitpointArm = "legacy" | "store";

export type CreateTestEngineOptions = Omit<RunEngineOptions, "waitpointStore"> & {
  /** Defaults to legacy, which is the behaviour every pre-existing test expects. */
  waitpointArm?: WaitpointArm;
  /** Redis for the store arm. Defaults to the run lock's, which is what tests already pass. */
  waitpointStoreRedis?: RedisOptions;
};

/**
 * Build a RunEngine for a test, with the waitpoint arm selectable.
 *
 * The arm is a constructor concern rather than a per-call one: an engine with no store
 * configured cannot reach the store path at all, which is what an unflipped deployment
 * looks like. Tests that also want to exercise the mint flag pass `waitpointMintKind` at
 * the call site, as production does.
 */
export function createTestEngine(options: CreateTestEngineOptions): RunEngine {
  const { waitpointArm = "legacy", waitpointStoreRedis, ...engineOptions } = options;

  return new RunEngine({
    ...engineOptions,
    waitpointStore:
      waitpointArm === "store"
        ? { redis: waitpointStoreRedis ?? engineOptions.runLock.redis }
        : undefined,
  });
}

/**
 * A run friendly id whose shape suits the arm.
 *
 * A store RUN or BATCH waitpoint derives its id from the anchor's id body, so a store-arm
 * test that triggers with a legacy id mints a LEGACY waitpoint, passes every assertion,
 * and proves nothing. Use this rather than a literal.
 */
export function freshRunFriendlyId(arm: WaitpointArm): string {
  return arm === "store" ? RunId.toFriendlyId(generateRunOpsId()) : RunId.generate().friendlyId;
}

/**
 * Assert a store-arm test actually minted into the store.
 *
 * The failure this catches is a test that runs green on both arms while the store arm
 * quietly did nothing, which is the most plausible way for this migration to look
 * finished and not be. Call it where a test is expected to mint.
 */
export function assertStoreResident(waitpointId: string): void {
  if (parseWaitpointId(waitpointId).format !== "b32hexW") {
    throw new Error(
      `expected ${waitpointId} to be store resident; a store-arm test that mints a legacy ` +
        `waitpoint asserts nothing about the store path`
    );
  }
}

/**
 * Read a waitpoint from wherever the arm keeps it.
 *
 * A test that reads `prisma.waitpoint` directly is asserting against Postgres, which the
 * store arm does not write for RUN, BATCH or DATETIME. Routing status and output
 * assertions through here lets one expectation hold on both arms.
 */
export async function readWaitpointForArm(args: {
  arm: WaitpointArm;
  prisma: PrismaClient;
  redisOptions: RedisOptions;
  waitpointId: string;
}): Promise<Waitpoint | null> {
  if (args.arm === "legacy" || parseWaitpointId(args.waitpointId).format === "legacy") {
    return args.prisma.waitpoint.findFirst({ where: { id: args.waitpointId } });
  }

  const store = new WaitpointStoreCoordinator({ redisOptions: args.redisOptions });
  try {
    const held = await store.readWaitpoint(args.waitpointId);
    return held ? toPrismaWaitpoint(held.record, held.status, held.completion) : null;
  } finally {
    await store.quit();
  }
}

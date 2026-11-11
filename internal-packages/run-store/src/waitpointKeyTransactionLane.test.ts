import { postgresTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import {
  WAITPOINT_KEY_TRANSACTION_POOL_SIZE,
  WaitpointKeyTransactionBudgetExhaustedError,
  WaitpointKeyTransactionLane,
} from "./waitpointKeyTransactionLane.js";

async function expectBudgetExhausted(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toMatchObject({
    name: "WaitpointKeyTransactionBudgetExhaustedError",
    message: "Keyed waitpoint creation transaction budget exhausted",
  });
  expect(error).toBeInstanceOf(WaitpointKeyTransactionBudgetExhaustedError);
}

function countedLane(createClient: () => PrismaClient) {
  const exhausted = { count: 0 };
  const lane = new WaitpointKeyTransactionLane(createClient, {
    recordBudgetExhausted: () => exhausted.count++,
  });
  return { lane, exhausted };
}

// Blocks the event loop past a real deadline that is tens of milliseconds away, so no lane
// timer or I/O can run in between.
function holdPast(deadline: number) {
  while (Date.now() <= deadline) continue;
}

describe("WaitpointKeyTransactionLane budget exhaustion", () => {
  // Catches: keyed creation that runs out of time before entry, from inside the callback, or
  // while queued behind a full lane surfacing as a plain Error (a 500) or going uncounted.
  postgresTest(
    "rejects with a typed, counted error when the budget is spent before entry or while queued",
    async ({ postgresContainer }) => {
      const url = postgresContainer.getConnectionUri();
      const { lane, exhausted } = countedLane(
        () => new PrismaClient({ datasources: { db: { url } } })
      );
      const gates: Array<() => void> = [];
      const held: Promise<unknown>[] = [];
      try {
        await expectBudgetExhausted(lane.run("org-a", Date.now() - 1, async () => "never"));
        expect(exhausted.count).toBe(1);
        // The engine's own budget checks throw the same error from inside the callback.
        await expectBudgetExhausted(
          lane.run("org-a", Date.now() + 10_000, async () => {
            throw new WaitpointKeyTransactionBudgetExhaustedError();
          })
        );
        expect(exhausted.count).toBe(2);

        let entered = 0;
        for (let org = 0; org < WAITPOINT_KEY_TRANSACTION_POOL_SIZE; org++) {
          const gate = new Promise<void>((resolve) => gates.push(resolve));
          held.push(
            lane.run(`org-${org}`, Date.now() + 10_000, async () => {
              entered++;
              await gate;
            })
          );
        }
        await expect
          .poll(() => entered, { timeout: 5_000, message: "lane never filled" })
          .toBe(WAITPOINT_KEY_TRANSACTION_POOL_SIZE);

        // Every slot is held, so this waiter's tiny budget runs out in the queue.
        await expectBudgetExhausted(lane.run("org-queued", Date.now() + 50, async () => "never"));
        expect(exhausted.count).toBe(3);
      } finally {
        gates.forEach((release) => release());
        await Promise.allSettled(held);
        await lane.close();
      }
    }
  );

  // Catches: keyed creation whose deadline passes after it is admitted, or before its first
  // statement runs, surfacing as a plain Error (a 500) or going uncounted.
  postgresTest(
    "rejects with a typed, counted error when the deadline passes after admission or before the first statement",
    async ({ postgresContainer }) => {
      const client = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
      });
      await client.$connect();
      let deadline = 0;
      // Opening the client is the gap between admission and the transaction callback.
      const { lane, exhausted } = countedLane(() => {
        holdPast(deadline);
        return client;
      });
      try {
        // A free slot admits synchronously; holding the caller lets the deadline pass first.
        deadline = Date.now() + 20;
        const admitted = lane.run("org-a", deadline, async () => "never");
        holdPast(deadline);
        await expectBudgetExhausted(admitted);
        expect(exhausted.count).toBe(1);

        deadline = Date.now() + 50;
        await expectBudgetExhausted(lane.run("org-a", deadline, async () => "never"));
        expect(exhausted.count).toBe(2);
      } finally {
        await lane.close();
      }
    }
  );
});

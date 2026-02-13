import { batch, logger, task } from "@trigger.dev/sdk";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

/**
 * Tight computational loop that produces sustained high CPU utilization.
 * Uses repeated SHA-256 hashing to keep the CPU busy.
 */
export const cpuIntensive = task({
  id: "cpu-intensive",
  run: async (
    {
      durationSeconds = 60,
    }: {
      durationSeconds?: number;
    },
    { ctx }
  ) => {
    logger.info("Starting CPU-intensive workload", { durationSeconds });

    const deadline = Date.now() + durationSeconds * 1000;
    let iterations = 0;
    let data = Buffer.from("seed-data-for-hashing");

    while (Date.now() < deadline) {
      // Tight hashing loop — ~100ms chunks then yield to event loop
      const chunkEnd = Date.now() + 100;
      while (Date.now() < chunkEnd) {
        data = createHash("sha256").update(data).digest();
        iterations++;
      }
      // Yield to let metrics collection and heartbeats run
      await setTimeout(1);
    }

    logger.info("CPU-intensive workload complete", { iterations });
    return { iterations };
  },
});

/**
 * Progressively allocates memory in steps, holds it, then releases.
 * Produces a staircase-shaped memory usage graph.
 */
export const memoryRamp = task({
  id: "memory-ramp",
  run: async (
    {
      steps = 6,
      stepSizeMb = 50,
      stepIntervalSeconds = 5,
      holdSeconds = 15,
    }: {
      steps?: number;
      stepSizeMb?: number;
      stepIntervalSeconds?: number;
      holdSeconds?: number;
    },
    { ctx }
  ) => {
    logger.info("Starting memory ramp", { steps, stepSizeMb, stepIntervalSeconds, holdSeconds });

    const allocations: Buffer[] = [];

    // Ramp up — allocate in steps
    for (let i = 0; i < steps; i++) {
      const buf = Buffer.alloc(stepSizeMb * 1024 * 1024, 0xff);
      allocations.push(buf);
      logger.info(`Allocated step ${i + 1}/${steps}`, {
        totalAllocatedMb: (i + 1) * stepSizeMb,
      });
      await setTimeout(stepIntervalSeconds * 1000);
    }

    // Hold at peak
    logger.info("Holding at peak memory", { totalMb: steps * stepSizeMb });
    await setTimeout(holdSeconds * 1000);

    // Release
    allocations.length = 0;
    global.gc?.();
    logger.info("Released all allocations");

    // Let metrics capture the drop
    await setTimeout(10_000);

    logger.info("Memory ramp complete");
    return { peakMb: steps * stepSizeMb };
  },
});

/**
 * Alternates between CPU-intensive bursts and idle sleep periods.
 * Produces a sawtooth/square-wave CPU utilization pattern.
 */
export const burstyWorkload = task({
  id: "bursty-workload",
  run: async (
    {
      cycles = 5,
      burstSeconds = 5,
      idleSeconds = 5,
    }: {
      cycles?: number;
      burstSeconds?: number;
      idleSeconds?: number;
    },
    { ctx }
  ) => {
    logger.info("Starting bursty workload", { cycles, burstSeconds, idleSeconds });

    for (let cycle = 0; cycle < cycles; cycle++) {
      // Burst phase — hash as fast as possible
      logger.info(`Cycle ${cycle + 1}/${cycles}: burst phase`);
      const burstDeadline = Date.now() + burstSeconds * 1000;
      let data = Buffer.from(`burst-cycle-${cycle}`);
      while (Date.now() < burstDeadline) {
        const chunkEnd = Date.now() + 100;
        while (Date.now() < chunkEnd) {
          data = createHash("sha256").update(data).digest();
        }
        await setTimeout(1);
      }

      // Idle phase
      logger.info(`Cycle ${cycle + 1}/${cycles}: idle phase`);
      await setTimeout(idleSeconds * 1000);
    }

    logger.info("Bursty workload complete", { totalCycles: cycles });
    return { cycles };
  },
});

/**
 * Simulates a data processing pipeline with distinct phases:
 *   1. Read phase — light CPU, growing memory (buffering data)
 *   2. Process phase — high CPU, stable memory (crunching data)
 *   3. Write phase — low CPU, memory drops (streaming out results)
 *
 * Shows clear phase transitions in both CPU and memory graphs.
 */
export const sustainedWorkload = task({
  id: "sustained-workload",
  run: async (
    {
      readSeconds = 20,
      processSeconds = 20,
      writeSeconds = 20,
      dataSizeMb = 100,
    }: {
      readSeconds?: number;
      processSeconds?: number;
      writeSeconds?: number;
      dataSizeMb?: number;
    },
    { ctx }
  ) => {
    logger.info("Starting sustained workload — read phase", { readSeconds, dataSizeMb });

    // Phase 1: Read — gradually accumulate buffers (memory ramp, low CPU)
    const chunks: Buffer[] = [];
    const chunkCount = 10;
    const chunkSize = Math.floor((dataSizeMb * 1024 * 1024) / chunkCount);
    const readInterval = (readSeconds * 1000) / chunkCount;

    for (let i = 0; i < chunkCount; i++) {
      chunks.push(Buffer.alloc(chunkSize, i));
      logger.info(`Read ${i + 1}/${chunkCount} chunks`);
      await setTimeout(readInterval);
    }

    // Phase 2: Process — hash all chunks repeatedly (high CPU, stable memory)
    logger.info("Entering process phase", { processSeconds });
    const processDeadline = Date.now() + processSeconds * 1000;
    let hashCount = 0;

    while (Date.now() < processDeadline) {
      const chunkEnd = Date.now() + 100;
      while (Date.now() < chunkEnd) {
        for (const chunk of chunks) {
          createHash("sha256").update(chunk).digest();
          hashCount++;
        }
      }
      await setTimeout(1);
    }

    // Phase 3: Write — release memory gradually (low CPU, memory drops)
    logger.info("Entering write phase", { writeSeconds });
    const writeInterval = (writeSeconds * 1000) / chunkCount;

    for (let i = chunkCount - 1; i >= 0; i--) {
      chunks.pop();
      logger.info(`Wrote and released chunk ${chunkCount - i}/${chunkCount}`);
      await setTimeout(writeInterval);
    }

    global.gc?.();
    await setTimeout(5000);

    logger.info("Sustained workload complete", { hashCount });
    return { hashCount };
  },
});

/**
 * Parent task that fans out multiple child tasks in parallel.
 * Useful for seeing per-run breakdowns in metrics queries grouped by run_id.
 */
export const concurrentLoad = task({
  id: "concurrent-load",
  run: async (
    {
      concurrency = 3,
      taskType = "bursty-workload" as "cpu-intensive" | "bursty-workload",
      durationSeconds = 30,
    }: {
      concurrency?: number;
      taskType?: "cpu-intensive" | "bursty-workload";
      durationSeconds?: number;
    },
    { ctx }
  ) => {
    logger.info("Starting concurrent load", { concurrency, taskType, durationSeconds });

    const items = Array.from({ length: concurrency }, (_, i) => {
      if (taskType === "cpu-intensive") {
        return { id: cpuIntensive.id, payload: { durationSeconds } };
      }
      return {
        id: burstyWorkload.id,
        payload: { cycles: 3, burstSeconds: 5, idleSeconds: 5 },
      };
    });

    const results = await batch.triggerAndWait<typeof cpuIntensive | typeof burstyWorkload>(items);

    logger.info("All children completed", {
      count: results.runs.length,
    });

    return { childRunIds: results.runs.map((r) => r.id) };
  },
});

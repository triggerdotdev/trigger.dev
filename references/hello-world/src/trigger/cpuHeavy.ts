import { task, heartbeats } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const cpuHeavyTask = task({
  id: "cpu-heavy-task",
  machine: "small-1x",
  run: async (
    {
      durationInMs = 1000,
      yieldToHeartbeats = false,
    }: { durationInMs: number; yieldToHeartbeats: boolean },
    { ctx }
  ) => {
    console.log("🧠 Starting CPU-heavy work");

    // await setTimeout(durationInMs);

    await simulateCpuHeavyWork(durationInMs, yieldToHeartbeats);

    console.log("🧠 CPU-heavy work completed");
  },
});

async function simulateCpuHeavyWork(durationInMs: number, yieldToHeartbeats: boolean) {
  const start = Date.now();
  while (Date.now() - start < durationInMs) {
    // Simulate 1 second of CPU-intensive work
    if (yieldToHeartbeats) {
      await heartbeats.yield();
    }
  }
}

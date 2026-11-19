import {
  ExecutorToWorkerMessageCatalog,
  WorkerToExecutorMessageCatalog,
} from "@trigger.dev/core/v3";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { DevUsageManager, ProdUsageManager } from "@trigger.dev/core/v3/workers";
import { setTimeout as sleep } from "node:timers/promises";
import { installUsageJwt } from "../../src/entryPoints/usageJwt.js";

const current = { run: { id: "run_a" }, attempt: { number: 2 } };
const manager = new ProdUsageManager(new DevUsageManager(), {
  url: process.env.USAGE_EVENT_URL,
  jwt: process.env.TRIGGER_JWT,
  heartbeatIntervalMs: 60_000,
});
const measurement = manager.start();
let resume!: () => void;
const paused = manager.pauseAsync(() => new Promise<void>((resolve) => (resume = resolve)));

new ZodIpcConnection({
  listenSchema: WorkerToExecutorMessageCatalog,
  emitSchema: ExecutorToWorkerMessageCatalog,
  process,
  handlers: {
    UPDATE_USAGE_JWT: async (update) =>
      process.env.FIXTURE_LEGACY_CHILD
        ? undefined
        : { installed: installUsageJwt(current, manager, update) },
    RESOLVE_WAITPOINT: async () => {
      resume();
    },
    FLUSH: async (_message, sender) => {
      await paused;
      await sleep(10);
      manager.stop(measurement);
      await manager.flush();
      manager.disable();
      await sender.send("SEND_DEBUG_LOG", { message: "flushed" });
    },
  },
});

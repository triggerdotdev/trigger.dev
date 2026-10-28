import {
  ExecutorToWorkerMessageCatalog,
  WorkerToExecutorMessageCatalog,
} from "@trigger.dev/core/v3";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { installRunToken } from "../../src/entryPoints/runTokenEnv.js";

// Forked by src/executions/taskRunProcess.runToken.test.ts. Stands in for managed-run-worker, which is executing
// the attempt named by the FIXTURE_* env vars.
const current = {
  run: { id: process.env.FIXTURE_RUN_ID! },
  attempt: { number: Number(process.env.FIXTURE_ATTEMPT) },
};

new ZodIpcConnection({
  listenSchema: WorkerToExecutorMessageCatalog,
  emitSchema: ExecutorToWorkerMessageCatalog,
  process,
  handlers: {
    // Reads back the child's own environment so the test sees what the SDK would.
    FLUSH: async (_message: unknown, sender) => {
      await sender.send("SEND_DEBUG_LOG", { message: process.env.TRIGGER_RUN_TOKEN ?? "" });
    },
    // A legacy child has no handler, and acks the message without a payload.
    UPDATE_RUN_TOKEN: async (update: { runId: string; attemptNumber: number; token: string }) =>
      process.env.FIXTURE_LEGACY_CHILD
        ? undefined
        : { installed: installRunToken(current, update) },
  },
});

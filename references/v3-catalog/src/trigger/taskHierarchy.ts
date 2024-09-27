import { runs, task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "node:timers/promises";

export const rootTask = task({
  id: "task-hierarchy/root-task",
  run: async (
    { useWaits = true, useBatch = false }: { useWaits: boolean; useBatch: boolean },
    { ctx }
  ) => {
    console.log("root-task");

    if (useWaits) {
      if (useBatch) {
        await childTask.batchTriggerAndWait([{ payload: { useWaits, useBatch } }]);
      } else {
        await childTask.triggerAndWait({ useWaits, useBatch });
      }
    } else {
      if (useBatch) {
        await childTask.batchTrigger([
          { payload: { useWaits, useBatch } },
          { payload: { useWaits, useBatch } },
        ]);
      } else {
        await childTask.trigger({ useWaits, useBatch });
      }
    }

    if (!useWaits) {
      await setTimeout(10_000); // Wait for 10 seconds, all the runs will be finished by then
    }

    await logRunHierarchy(ctx.run.id);
  },
});

export const childTask = task({
  id: "task-hierarchy/child-task",
  run: async ({ useWaits = true, useBatch = false }: { useWaits: boolean; useBatch: boolean }) => {
    console.log("child-task");

    if (useWaits) {
      if (useBatch) {
        await grandChildTask.batchTriggerAndWait([{ payload: { useWaits, useBatch } }]);
      } else {
        await grandChildTask.triggerAndWait({ useWaits, useBatch });
      }
    } else {
      if (useBatch) {
        await grandChildTask.batchTrigger([{ payload: { useWaits, useBatch } }]);
      } else {
        await grandChildTask.trigger({ useWaits, useBatch });
      }
    }
  },
});

export const grandChildTask = task({
  id: "task-hierarchy/grand-child-task",
  run: async ({ useWaits = true, useBatch = false }: { useWaits: boolean; useBatch: boolean }) => {
    console.log("grand-child-task");

    if (useWaits) {
      if (useBatch) {
        await greatGrandChildTask.batchTriggerAndWait([{ payload: { useWaits, useBatch } }]);
      } else {
        await greatGrandChildTask.triggerAndWait({ useWaits, useBatch });
      }
    } else {
      if (useBatch) {
        await greatGrandChildTask.batchTrigger([{ payload: { useWaits, useBatch } }]);
      } else {
        await greatGrandChildTask.trigger({ useWaits, useBatch });
      }
    }
  },
});

export const greatGrandChildTask = task({
  id: "task-hierarchy/great-grand-child-task",
  run: async ({ useWaits = true, useBatch = false }: { useWaits: boolean; useBatch: boolean }) => {
    console.log("great-grand-child-task");
  },
});

async function logRunHierarchy(
  runId: string,
  parentTaskIdentifier?: string,
  triggerFunction?: string
) {
  const runData = await runs.retrieve(runId);

  const indent = " ".repeat(runData.depth * 2);
  const triggerInfo = triggerFunction ? ` (triggered by ${triggerFunction})` : "";
  const parentInfo = parentTaskIdentifier ? ` (parent task: ${parentTaskIdentifier})` : "";

  console.log(
    `${indent}Level ${runData.depth}: [${runData.taskIdentifier}] run ${runData.id}${triggerInfo}${parentInfo}`
  );

  for (const childRun of runData.relatedRuns.children ?? []) {
    await logRunHierarchy(childRun.id, runData.taskIdentifier, childRun.triggerFunction);
  }
}

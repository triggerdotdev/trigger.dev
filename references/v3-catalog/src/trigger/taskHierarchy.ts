import { task } from "@trigger.dev/sdk/v3";

export const rootTask = task({
  id: "task-hierarchy/root-task",
  run: async ({ useWaits = true }: { useWaits: boolean }) => {
    console.log("root-task");

    if (useWaits) {
      await childTask.triggerAndWait({ useWaits });
      await childTask.batchTriggerAndWait([{ payload: { useWaits } }]);
    } else {
      await childTask.trigger({ useWaits });
      await childTask.batchTrigger([{ payload: { useWaits } }]);
    }
  },
});

export const childTask = task({
  id: "task-hierarchy/child-task",
  run: async ({ useWaits = true }: { useWaits: boolean }) => {
    console.log("child-task");

    if (useWaits) {
      await grandChildTask.triggerAndWait({ useWaits });
      await grandChildTask.batchTriggerAndWait([{ payload: { useWaits } }]);
    } else {
      await grandChildTask.trigger({ useWaits });
      await grandChildTask.batchTrigger([{ payload: { useWaits } }]);
    }
  },
});

export const grandChildTask = task({
  id: "task-hierarchy/grand-child-task",
  run: async ({ useWaits = true }: { useWaits: boolean }) => {
    console.log("grand-child-task");

    if (useWaits) {
      await greatGrandChildTask.triggerAndWait({ useWaits });
      await greatGrandChildTask.batchTriggerAndWait([{ payload: { useWaits } }]);
    } else {
      await greatGrandChildTask.trigger({ useWaits });
      await greatGrandChildTask.batchTrigger([{ payload: { useWaits } }]);
    }
  },
});

export const greatGrandChildTask = task({
  id: "task-hierarchy/great-grand-child-task",
  run: async ({ useWaits = true }: { useWaits: boolean }) => {
    console.log("great-grand-child-task");
  },
});

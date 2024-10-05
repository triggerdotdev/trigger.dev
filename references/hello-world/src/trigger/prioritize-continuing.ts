import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const prioritizeContinuing = task({
  id: "prioritize-continuing",
  run: async ({ count }: { count: number }) => {
    await prioritizeContinuingChild.batchTrigger(
      Array.from({ length: count }, (_, i) => ({ payload: {} as any }))
    );
  },
});

export const prioritizeContinuingChild = task({
  id: "prioritize-continuing-child",
  queue: {
    concurrencyLimit: 1,
  },
  run: async () => {
    await fixedLengthTask.triggerAndWait({ waitSeconds: 1 });
  },
});

export const fixedLengthTask = task({
  id: "fixedLengthTask",
  run: async ({ waitSeconds }: { waitSeconds: number }) => {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  },
});

import { logger, task, metadata, AbortTaskRunError } from "@trigger.dev/sdk/v3";

export const runMetadataTask = task({
  id: "run-metadata-task",
  run: async (payload: any) => {
    await runMetadataChildTask.triggerAndWait(payload, {
      metadata: {
        hello: "world",
        date: new Date(),
        anotherThing: {
          a: 1,
          b: 2,
        },
      },
    });
  },
});

export const runMetadataChildTask = task({
  id: "run-metadata-child-task",
  run: async (payload: any, { ctx }) => {
    await metadata.set("child", "task");

    logger.info("metadata", { metadata: metadata.current() });

    await metadata.set("child-2", "task-2");

    logger.info("metadata", { current: metadata.current() });

    await metadata.del("hello");

    logger.info("metadata", { metadata: metadata.current() });

    await metadata.save({
      there: {
        is: {
          something: "here",
        },
      },
    });

    await runMetadataChildTask2.triggerAndWait(payload, {
      metadata: metadata.current(),
    });

    return metadata.current();
  },
  onStart: async () => {
    logger.info("metadata", { metadata: metadata.current() });
  },
  onSuccess: async () => {
    logger.info("metadata", { metadata: metadata.current() });
  },
});

export const runMetadataChildTask2 = task({
  id: "run-metadata-child-task-2",
  run: async (payload: any, { ctx }) => {
    throw new AbortTaskRunError("aborting");
  },
});

export const myTask = task({
  id: "my-task",
  run: async (payload: any) => {},
});

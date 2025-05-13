import { logger, task, metadata, AbortTaskRunError } from "@trigger.dev/sdk/v3";

export const runMetadataTask = task({
  id: "run-metadata-task",
  run: async (payload: any) => {
    metadata.set("numberOfChildren", 2);

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
    metadata.parent.increment("numberOfChildren", 1);
    metadata.root.increment("numberOfChildren", 1);

    logger.info("metadata", { metadata: metadata.current() });

    metadata.set("child", "task");

    logger.info("metadata", { metadata: metadata.current() });

    metadata.set("child-2", "task-2");

    logger.info("metadata", { current: metadata.current() });

    metadata.del("hello");

    logger.info("metadata", { metadata: metadata.current() });

    metadata.replace({
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
    metadata.root.increment("numberOfChildren", 1);
  },
});

export const myTask = task({
  id: "my-task",
  run: async (payload: any) => {},
});

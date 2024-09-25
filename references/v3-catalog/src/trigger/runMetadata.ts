import { logger, task, metadata } from "@trigger.dev/sdk/v3";

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
    logger.info("metadata", { metadata: ctx.run.metadata });

    await metadata.set("child", "task");

    logger.info("metadata", { metadata: metadata.current() });

    const returnedMetadata = await metadata.set("child-2", "task-2");

    logger.info("metadata", { metadata: returnedMetadata, current: metadata.current() });

    await metadata.del("hello");

    logger.info("metadata", { metadata: metadata.current() });

    await metadata.update({
      there: {
        is: {
          something: "here",
        },
      },
    });

    // Now try and update the metadata with something larger than 8KB
    await metadata.update({
      large: new Array(10000).fill("a").join(""),
    });
  },
});

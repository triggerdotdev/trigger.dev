import { logger, task, wait } from "@trigger.dev/sdk";

export const tagsTester = task({
  id: "tags-tester",
  run: async (payload: any, { ctx }) => {
    await tagsChildTask.trigger(
      {
        tags: ["tag1", "tag2"],
      },
      {
        tags: ["user:user1", "org:org1"],
      }
    );
  },
});

export const tagsChildTask = task({
  id: "tags-child",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the child", { payload });
  },
});

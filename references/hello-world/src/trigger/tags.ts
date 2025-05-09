import { logger, runs, task, wait } from "@trigger.dev/sdk";
import assert from "node:assert";
import { setTimeout } from "node:timers/promises";

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

// Task that will be triggered with tags
export const taggedTask = task({
  id: "tagged-task",
  run: async (payload: { waitSeconds: number }, { ctx }) => {
    logger.info("Running tagged task", { tags: ctx.run.tags });

    // Verify initial tags from trigger
    const expectedInitialTags = ["test-tag-1", "test-tag-2"];
    for (const tag of expectedInitialTags) {
      if (!ctx.run.tags.includes(tag)) {
        throw new Error(`Expected tag ${tag} to be present initially`);
      }
    }

    // Wait a bit to ensure we can query the running task
    await setTimeout(payload.waitSeconds * 1000);

    return {
      initialTags: ctx.run.tags,
    };
  },
});

// Test task that verifies tag behavior
export const tagTestTask = task({
  id: "tag-test",
  run: async (payload, { ctx }) => {
    logger.info("Starting tag verification test");

    // Trigger a task with initial tags
    const handle = await taggedTask.trigger(
      { waitSeconds: 3 },
      {
        tags: ["test-tag-1", "test-tag-2"],
      }
    );

    // Wait a moment to ensure the task is running
    await setTimeout(3_000);

    // Query for running tasks with our tags
    const runningTasks = await runs.list({
      status: "EXECUTING",
      tag: ["test-tag-1", "test-tag-2"],
    });

    let foundRun = false;
    for await (const run of runningTasks) {
      if (run.id === handle.id) {
        foundRun = true;
        break;
      }
    }

    if (!foundRun) {
      throw new Error("Could not find running task with tags test-tag-1 and test-tag-2");
    }

    logger.info("Found running task with tags test-tag-1 and test-tag-2");

    await wait.for({ seconds: 10 });

    const finalRun = await runs.retrieve<typeof taggedTask>(handle.id);

    logger.info("Final run", { finalRun });

    assert.ok(finalRun.status === "COMPLETED", "Run should be completed");
    assert.ok(finalRun.output, "Output should be defined");

    // Verify the tags were preserved in the task context
    const outputTags = finalRun.output.initialTags;
    if (!outputTags.includes("test-tag-1") || !outputTags.includes("test-tag-2")) {
      throw new Error(
        `Expected tags test-tag-1 and test-tag-2 in output, got ${outputTags.join(", ")}`
      );
    }

    logger.info("✅ Tag verification test passed");
  },
});

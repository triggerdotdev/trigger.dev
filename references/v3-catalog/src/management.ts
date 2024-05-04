import { APIError, runs, schedules } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./trigger/subtasks";
import dotenv from "dotenv";
import { firstScheduledTask } from "./trigger/scheduled";

dotenv.config();

export async function run() {
  try {
    const run = await simpleChildTask.trigger({ message: "Hello, World!" });

    const retrievedRun = await runs.retrieve(run.id);
    console.log("retrieved run", retrievedRun);

    const canceled = await runs.cancel(run.id);
    console.log("canceled run", canceled);

    const replayed = await runs.replay(run.id);
    console.log("replayed run", replayed);

    const run2 = await simpleChildTask.trigger(
      { message: "Hello, World!" },
      {
        idempotencyKey: "mmvlgwcidiklyeygen4",
      }
    );

    const run3 = await simpleChildTask.trigger(
      { message: "Hello, World again!" },
      {
        idempotencyKey: "mmvlgwcidiklyeygen4",
      }
    );

    console.log("run2", run2);
    console.log("run3", run3);

    const allSchedules = await schedules.list();

    console.log("all schedules", allSchedules);

    // Create a schedule
    const createdSchedule = await schedules.create({
      task: firstScheduledTask.id,
      cron: "0 0 * * *",
      externalId: "ext_1234444",
      deduplicationKey: "dedup_1234444",
    });

    console.log("created schedule", createdSchedule);

    const retrievedSchedule = await schedules.retrieve(createdSchedule.id);

    console.log("retrieved schedule", retrievedSchedule);

    const updatedSchedule = await schedules.update(createdSchedule.id, {
      task: firstScheduledTask.id,
      cron: "0 0 1 * *",
      externalId: "ext_1234444",
    });

    console.log("updated schedule", updatedSchedule);

    const deactivatedSchedule = await schedules.deactivate(createdSchedule.id);

    console.log("deactivated schedule", deactivatedSchedule);

    const activatedSchedule = await schedules.activate(createdSchedule.id);

    console.log("activated schedule", activatedSchedule);

    const deletedSchedule = await schedules.del(createdSchedule.id);

    console.log("deleted schedule", deletedSchedule);
  } catch (error) {
    if (error instanceof APIError) {
      console.error("APIError", error);
    } else {
      console.error("Unknown error", error);
    }
  }
}

run();

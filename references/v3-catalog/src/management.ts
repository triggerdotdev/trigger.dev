import { runs, schedules } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./trigger/subtasks";
import dotenv from "dotenv";
import { firstScheduledTask } from "./trigger/scheduled";

dotenv.config();

export async function run() {
  const run = await simpleChildTask.trigger({ payload: { message: "Hello, World!" } });
  const canceled = await runs.cancel(run.id);
  console.log("canceled run", canceled);

  const replayed = await runs.replay(run.id);
  console.log("replayed run", replayed);

  const run2 = await simpleChildTask.trigger({
    payload: { message: "Hello, World!" },
    options: {
      idempotencyKey: "mmvlgwcidiklyeygen4",
    },
  });

  const run3 = await simpleChildTask.trigger({
    payload: { message: "Hello, World again!" },
    options: {
      idempotencyKey: "mmvlgwcidiklyeygen4",
    },
  });

  console.log("run2", run2);
  console.log("run3", run3);

  const allSchedules = await schedules.list();

  // Create a schedule
  const createdSchedule = await schedules.create({
    task: firstScheduledTask.id,
    cron: "0 0 * * *",
    externalId: "ext_1234444",
    deduplicationKey: "dedup_1234444",
  });

  if (createdSchedule.ok) {
    console.log("created schedule", createdSchedule.data);

    const retrievedSchedule = await schedules.retrieve(createdSchedule.data.id);

    if (retrievedSchedule.ok) {
      console.log("retrieved schedule", retrievedSchedule.data);

      const updatedSchedule = await schedules.update(createdSchedule.data.id, {
        task: firstScheduledTask.id,
        cron: "0 0 1 * *",
        externalId: "ext_1234444",
      });

      if (updatedSchedule.ok) {
        console.log("updated schedule", updatedSchedule.data);

        const deactivatedSchedule = await schedules.deactivate(createdSchedule.data.id);

        if (deactivatedSchedule.ok) {
          console.log("deactivated schedule", deactivatedSchedule.data);
        } else {
          console.error("failed to deactivate schedule", deactivatedSchedule.error);
        }

        const activatedSchedule = await schedules.activate(createdSchedule.data.id);

        if (activatedSchedule.ok) {
          console.log("activated schedule", activatedSchedule.data);

          const deletedSchedule = await schedules.del(createdSchedule.data.id);

          if (deletedSchedule.ok) {
            console.log("deleted schedule", deletedSchedule.data);
          }
        }
      }
    }
  }
}

run();

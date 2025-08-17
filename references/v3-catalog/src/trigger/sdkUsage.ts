import { task, tasks, runs, logger, schedules, envvars } from "@trigger.dev/sdk/v3";

export const sdkUsage = task({
  id: "sdk-usage",
  run: async (payload: any, { ctx }) => {
    const $runs = await runs.list({
      limit: 10,
      status: "COMPLETED",
    });

    const $firstRun = await runs.retrieve($runs.data[0].id);

    const handle = await tasks.trigger<typeof sdkChild>("sdk-child", {
      run: $firstRun,
    });

    const replayedRun = await runs.replay($firstRun.id);

    await runs.cancel(replayedRun.id);

    const delayed = await tasks.trigger<typeof sdkChild>(
      "sdk-child",
      {
        delay: "1h",
      },
      {
        delay: "1h",
      }
    );

    await runs.reschedule(delayed.id, {
      delay: "1m",
    });

    for await (const run of runs.list({
      limit: 10,
      period: "1d",
    })) {
      logger.log(run.id, { run });
    }

    const batchHandle = await sdkChild.batchTrigger([
      {
        payload: {},
      },
    ]);

    const waitResult = await sdkChild.triggerAndWait({
      payload: {},
    });

    await sdkChild.batchTriggerAndWait([
      {
        payload: {},
      },
    ]);

    await tasks.batchTrigger<typeof sdkChild>("sdk-child", [
      {
        payload: {},
      },
    ]);

    const schedule = await schedules.create({
      cron: "0 0 * * *", // every day at midnight
      deduplicationKey: ctx.run.id,
      externalId: ctx.run.id,
      task: "sdk-schedule",
    });

    await schedules.retrieve(schedule.id);

    await schedules.del(schedule.id);

    await envvars.upload({
      variables: {
        INSIDE_RUN: "true",
      },
      override: true,
    });

    await envvars.list({
      retry: {
        maxAttempts: 3,
      },
    });

    await envvars.create(
      {
        name: "INSIDE_RUN_2",
        value: "true",
      },
      {
        retry: {
          maxAttempts: 3,
        },
      }
    );

    await envvars.retrieve("INSIDE_RUN_2");

    await envvars.update(
      "INSIDE_RUN_2",
      {
        value: "false",
      },
      {
        retry: {
          maxAttempts: 3,
        },
      }
    );
  },
});

export const sdkChild = task({
  id: "sdk-child",
  run: async (payload: any) => {
    return payload;
  },
});

export const sdkSchedule = schedules.task({
  id: "sdk-schedule",
  run: async (payload: any) => {},
});

export const autoResolvePayloadAndOutput = task({
  id: "auto-resolve-payload-and-output",
  run: async (payload: any, { ctx }) => {
    // Generate a large JSON payload (bigger than 128KB)
    const childPayload = Array.from({ length: 10000 }, () => ({
      key: "value",
      date: new Date(),
    }));

    const handle = await tasks.trigger<typeof sdkChild>("sdk-child", childPayload);

    const childRun = await runs.retrieve(handle.id);

    if (childRun.payload) {
      console.log("Child run payload exists", {
        payloadPresignedUrl: childRun.payloadPresignedUrl,
      });
    } else {
      console.log("Child run payload does not exist", {
        payloadPresignedUrl: childRun.payloadPresignedUrl,
      });
    }

    await runs.poll(handle.id);

    const finishedRun = await runs.retrieve(handle.id);

    if (finishedRun.output) {
      console.log("Finished run output exists", {
        outputPresignedUrl: finishedRun.outputPresignedUrl,
      });
    } else {
      console.log("Finished run payload does not exist", {
        outputPresignedUrl: finishedRun.outputPresignedUrl,
      });
    }
  },
});

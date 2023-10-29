import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, invokeTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const invocableJob = client.defineJob({
  id: "invoke-example-1",
  name: "Invoke Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: invokeTrigger({
    schema: z.object({
      message: z.string(),
      forceError: z.boolean().default(false),
    }),
  }),
  run: async (payload, io, ctx) => {
    const generatingMemes = await io.createStatus("status-1", {
      //the label is compulsory on this first call
      label: "Generating memes",
      //state is optional
      state: "loading",
      //data is an optional object. the values can be any type that is JSON serializable
      data: {
        progress: 0.1,
      },
    });

    await io.runTask("task-1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    await io.wait("wait-1", 60);

    await io.runTask("task-2", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    await generatingMemes.update("middle-generation", {
      //label isn't specified so will remain the same
      //state will be updated to "success"
      state: "success",
      //set data, this overrides the previous value
      data: {
        progress: 1,
        urls: [
          "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnZoMndsdWh0MmhvY2kyaDF6YjZjZzg1ZGsxdnhhYm13a3Q1Y3lkbyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/13HgwGsXF0aiGY/giphy.gif",
        ],
      },
    });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      foo: payload.message,
    };
  },
});

client.defineJob({
  id: "invoke-example-2",
  name: "Invoke Example 2",
  version: "1.0.0",
  enabled: true,
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await invocableJob.invoke("invoke", {
      message: "Hello World 1",
    });

    await invocableJob.invoke(
      "invoke-with-url",
      {
        message: "Hello World 2",
      },
      {
        callbackUrl: process.env.REQUEST_BIN_URL,
      }
    );

    const result = await invocableJob.invokeAndWaitForCompletion("invoke-and-wait", {
      message: "Hello World 3",
    });

    if (result.ok) {
      await io.logger.info("Invoking job worked!", { result });
    } else {
      await io.logger.error("Invoking job failed!", { result });
    }
  },
});

createExpressServer(client);

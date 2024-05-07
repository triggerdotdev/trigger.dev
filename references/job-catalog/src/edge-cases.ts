import { createExpressServer } from "@trigger.dev/express";
import { Job, TriggerClient, invokeTrigger } from "@trigger.dev/sdk";
import fs from "node:fs";
import fsPromises from "node:fs/promises";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: true,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "task-output-edge-cases",
  name: "Task Output Edge Cases",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    const result1 = await io.runTask("undefined", async (task) => {
      return undefined;
    });

    if (typeof result1 !== "undefined") {
      throw new Error(`Expected undefined, got ${typeof result1}: ${JSON.stringify(result1)}`);
    }

    const result2 = await io.runTask("null", async (task) => {
      return null;
    });

    if (result2 !== null) {
      throw new Error(`Expected null, got ${typeof result2}: ${JSON.stringify(result2)}`);
    }

    const result3 = await io.runTask("false", async (task) => {
      return false;
    });

    if (typeof result3 !== "boolean" && result3 !== false) {
      throw new Error(`Expected false, got ${typeof result3}: ${JSON.stringify(result3)}`);
    }

    const result4 = await io.runTask("true", async (task) => {
      return true;
    });

    if (typeof result4 !== "boolean" && result4 !== true) {
      throw new Error(`Expected true, got ${typeof result4}: ${JSON.stringify(result4)}`);
    }

    const result5 = await io.runTask("date", async (task) => {
      return new Date();
    });

    if (typeof result5 !== "string" || new Date(result5).toString() === "Invalid Date") {
      throw new Error(`Expected string, got ${typeof result5}: ${JSON.stringify(result5)}`);
    }

    const result6 = await io.runTask("object", async (task) => {
      return {
        a: 1,
        b: "2",
        c: true,
        d: new Date(),
        e: null,
        f: undefined,
      };
    });

    if (typeof result6 !== "object" || result6 === null) {
      throw new Error(`Expected object, got ${typeof result6}: ${JSON.stringify(result6)}`);
    }

    const result7 = await io.runTask("array", async (task) => {
      return [1, "2", true, new Date(), null, undefined];
    });

    if (!Array.isArray(result7)) {
      throw new Error(`Expected array, got ${typeof result7}: ${JSON.stringify(result7)}`);
    }

    const result8 = await io.runTask("file", async (task) => {
      return fs.createReadStream(__filename) as any;
    });

    const result9 = await io.runTask("read-file", async (task) => {
      return fsPromises.readFile(__filename, "utf-8");
    });

    if (typeof result9 !== "string") {
      throw new Error(`Expected string, got ${typeof result9}: ${JSON.stringify(result9)}`);
    }

    const result10 = await io.runTask("big-json", async (task) => {
      return fetch("https://jsonplaceholder.typicode.com/photos").then((res) => res.json());
    });

    if (!Array.isArray(result10)) {
      throw new Error(`Expected array, got ${typeof result10}: ${JSON.stringify(result10)}`);
    }

    await io.wait("wait-1", 1);
  },
});

const job = new Job({
  id: "attach-to-client",
  name: "Attach to Client",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello from job", { ctx })
  },
}).attachToClient(client);

createExpressServer(client);

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ai } from "./ai.js";
import type { TaskWithSchema } from "@trigger.dev/core/v3";

describe("ai helper", function () {
  it("creates a tool from a schema task and executes through triggerAndWait", async function () {
    let receivedInput: unknown = undefined;

    const fakeTask = {
      id: "fake-task",
      description: "A fake task",
      schema: z.object({
        name: z.string(),
      }),
      triggerAndWait: function (payload: { name: string }) {
        receivedInput = payload;
        const resultPromise = Promise.resolve({
          ok: true,
          id: "run_123",
          taskIdentifier: "fake-task",
          output: {
            greeting: `Hello ${payload.name}`,
          },
        });

        return Object.assign(resultPromise, {
          unwrap: async function () {
            return {
              greeting: `Hello ${payload.name}`,
            };
          },
        });
      },
    } as unknown as TaskWithSchema<
      "fake-task",
      z.ZodObject<{ name: z.ZodString }>,
      { greeting: string }
    >;

    const tool = ai.tool(fakeTask);
    const result = await tool.execute?.(
      {
        name: "Ada",
      },
      undefined as never
    );

    expect(receivedInput).toEqual({
      name: "Ada",
    });
    expect(result).toEqual({
      greeting: "Hello Ada",
    });
  });

  it("throws when creating a tool from a task without schema", function () {
    const fakeTask = {
      id: "no-schema",
      description: "No schema task",
      schema: undefined,
      triggerAndWait: async function () {
        return {
          unwrap: async function () {
            return {};
          },
        };
      },
    } as unknown as TaskWithSchema<"no-schema", undefined, unknown>;

    expect(function () {
      ai.tool(fakeTask);
    }).toThrowError("task has no schema");
  });

  it("returns undefined for current tool options outside task execution context", function () {
    expect(ai.currentToolOptions()).toBeUndefined();
  });
});

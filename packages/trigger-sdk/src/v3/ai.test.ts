import { describe, expect, it, vi } from "vitest";
import { ai } from "./ai.js";
import { task, schemaTask } from "./tasks.js";
import { z } from "zod";

describe("ai.tool", () => {
  it("should pass triggerOptions to triggerAndWait", async () => {
    const myTask = schemaTask({
      id: "my-task",
      schema: z.object({ name: z.string() }),
      run: async (payload: { name: string }) => {
        return `Hello ${payload.name}`;
      },
    });

    const triggerAndWaitSpy = vi.spyOn(myTask, "triggerAndWait");
    triggerAndWaitSpy.mockReturnValue({
      unwrap: () => Promise.resolve("Hello world"),
    } as any);

    const tool = ai.tool(myTask, {
      triggerOptions: {
        priority: 10,
        tags: ["test-tag"],
      },
    });

    await tool.execute({ name: "world" }, {} as any);

    expect(triggerAndWaitSpy).toHaveBeenCalledWith(
      { name: "world" },
      expect.objectContaining({
        priority: 10,
        tags: ["test-tag"],
        metadata: expect.objectContaining({
           "tool.execute.options": {},
        }),
      })
    );
  });
});

import { tool } from "ai";
import { generateTestPayload as generateTestPayloadSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGenerateTestPayloadTool(ctx: ToolContext) {
  return tool({
    ...generateTestPayloadSchema,
    execute: async (params: { taskIdentifier: string; instruction?: string }) => {
      try {
        const { generatePayloadForTask } = await import("./generate-payload-adapter");
        return await generatePayloadForTask(ctx, params.taskIdentifier, params.instruction);
      } catch (error) {
        return {
          success: false,
          error: `Failed to generate test payload: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });
}

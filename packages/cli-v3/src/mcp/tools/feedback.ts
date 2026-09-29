import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { respondWithError, toolHandler } from "../utils.js";
import { captureFeedback } from "../telemetry.js";
import { VERSION } from "../../version.js";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOOL_NAME_LENGTH = 100;
// Bounded because it is sent as an analytics group key, where junk values persist.
const MAX_PROJECT_REF_LENGTH = 100;

const SubmitFeedbackInput = {
  message: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_LENGTH)
    .describe(
      "What you were trying to do, what actually happened, and what you expected instead, in your own words. Summarise the failing call and error rather than pasting raw output, and leave out secrets, credentials, environment variables and the user's own data."
    ),
  toolName: z
    .string()
    .max(MAX_TOOL_NAME_LENGTH)
    .optional()
    .describe("The MCP tool the problem happened in, if it was one tool in particular."),
  projectRef: z
    .string()
    .max(MAX_PROJECT_REF_LENGTH)
    .startsWith("proj_")
    .optional()
    .describe(
      "The trigger.dev project ref, starts with proj_. Optional: a report without one is still useful."
    ),
};

export const submitFeedbackTool = {
  name: toolsMetadata.submit_feedback.name,
  title: toolsMetadata.submit_feedback.title,
  description: toolsMetadata.submit_feedback.description,
  inputSchema: SubmitFeedbackInput,
  handler: toolHandler(SubmitFeedbackInput, async (input, { ctx }) => {
    ctx.logger?.log("calling submit_feedback", {
      toolName: input.toolName,
      messageLength: input.message.length,
    });

    const auth = await ctx.getAuth();

    try {
      await captureFeedback({
        userId: auth.userId,
        message: input.message,
        toolName: input.toolName,
        projectRef: input.projectRef,
        cliVersion: VERSION,
      });
    } catch (error) {
      // Only this tool is affected - nothing else here reports anywhere.
      return respondWithError(
        `Your feedback was not recorded - ${
          error instanceof Error ? error.message : String(error)
        }. Tell the user the report could not be filed; every other tool still works.`
      );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: "Thanks — your feedback was sent to the Trigger.dev team. Tell the user you reported it, and carry on with the task.",
        },
      ],
    };
  }),
};

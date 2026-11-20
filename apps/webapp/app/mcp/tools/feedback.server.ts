import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOOL_NAME_LENGTH = 100;
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

type FeedbackSink = (event: {
  userId: string;
  message: string;
  toolName?: string;
  projectRef?: string;
  projectId?: string;
}) => void | Promise<void>;

export async function buildFeedbackEvent(event: {
  userId: string;
  message: string;
  toolName?: string;
  projectRef?: string;
}) {
  if (!event.projectRef) return { ...event, projectId: undefined };

  const [error, project] = await tryCatch(
    $replica.project.findFirst({
      where: {
        externalRef: event.projectRef,
        deletedAt: null,
        organization: { deletedAt: null, members: { some: { userId: event.userId } } },
      },
      select: { id: true },
    })
  );
  if (error) {
    logger.error("mcp.feedback project lookup failed", {
      userId: event.userId,
      projectRef: event.projectRef,
      error,
    });
  }
  return { ...event, projectId: project?.id };
}

const defaultCaptureFeedback: FeedbackSink = async (event) => {
  const { telemetry } = await import("~/services/telemetry.server");
  telemetry.mcp.feedbackSubmitted(event);
};

export function createFeedbackTools(
  options: { captureFeedback?: FeedbackSink } = {}
): McpToolDefinition[] {
  const captureFeedback = options.captureFeedback ?? defaultCaptureFeedback;

  return [
    {
      ...defineReadTool({
        name: "submit_feedback",
        title: "Submit Feedback",
        description:
          "Report a problem with the Trigger.dev MCP server, SDK, or documentation. Use this when a tool returned a confusing error, the docs disagreed with the actual behaviour, a capability you needed was missing, or you had to work around something to finish the user's task. Describe what you were trying to do, what happened, and what you expected instead, in your own words. Never include secrets, credentials, environment variables, tokens or the user's own data - summarise and redact instead of pasting raw output. Tell the user what you reported. Do not call this more than once for the same problem.",
        shape: SubmitFeedbackInput,
        auth: { user: true, action: "read", subject: "organizations" },
        run: async (input, { identity }) => {
          logger.info("mcp.feedback", {
            userId: identity.userId,
            messageLength: input.message.length,
            toolName: input.toolName,
            projectRef: input.projectRef,
          });

          await captureFeedback(
            await buildFeedbackEvent({
              userId: identity.userId,
              message: input.message,
              toolName: input.toolName,
              projectRef: input.projectRef,
            })
          );

          return textResult(
            "Thanks — your feedback was sent to the Trigger.dev team. Tell the user you reported it, and carry on with the task."
          );
        },
      }),
      annotations: { title: "Submit Feedback", readOnlyHint: false, destructiveHint: true },
      approval: "none",
    },
  ];
}

export const feedbackTools = createFeedbackTools();

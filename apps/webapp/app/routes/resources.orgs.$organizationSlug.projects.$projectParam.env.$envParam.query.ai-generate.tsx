import { openai } from "@ai-sdk/openai";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import type { AITimeFilter } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/types";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { AIQueryService } from "~/v3/services/aiQueryService.server";
import { querySchemas } from "~/v3/querySchemas";

const RequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  mode: z.enum(["new", "edit"]).default("new"),
  currentQuery: z.string().optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  // Parse the request body
  const formData = await request.formData();
  const submission = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!submission.success) {
    return new Response(
      JSON.stringify({
        type: "result",
        success: false,
        error: "Invalid request data",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response(
      JSON.stringify({
        type: "result",
        success: false,
        error: "Project not found",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response(
      JSON.stringify({
        type: "result",
        success: false,
        error: "Environment not found",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({
        type: "result",
        success: false,
        error: "OpenAI API key is not configured",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const { prompt, mode, currentQuery } = submission.data;

  const service = new AIQueryService(
    querySchemas,
    openai(env.AI_RUN_FILTER_MODEL ?? "gpt-4o-mini")
  );

  // Create a streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: {
        type: string;
        content?: string;
        tool?: string;
        args?: unknown;
        result?: unknown;
        success?: boolean;
        query?: string;
        error?: string;
        filter?: AITimeFilter;
        timeFilter?: AITimeFilter;
      }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const result = service.streamQuery(prompt, { mode, currentQuery });

        // Process the stream
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              sendEvent({ type: "thinking", content: part.textDelta });
              break;
            }
            case "tool-call": {
              sendEvent({
                type: "tool_call",
                tool: part.toolName,
                args: part.args,
              });

              // If it's a setTimeFilter call, emit the time_filter event immediately
              if (part.toolName === "setTimeFilter") {
                const args = part.args as { period?: string; from?: string; to?: string };
                sendEvent({
                  type: "time_filter",
                  filter: {
                    period: args.period,
                    from: args.from,
                    to: args.to,
                  },
                });
              }
              break;
            }
            case "error": {
              sendEvent({
                type: "result",
                success: false,
                error: part.error instanceof Error ? part.error.message : String(part.error),
              });
              break;
            }
            case "finish": {
              // Extract query from the final text
              const finalText = await result.text;
              const query = extractQueryFromText(finalText);
              const timeFilter = service.getPendingTimeFilter();

              if (query) {
                sendEvent({
                  type: "result",
                  success: true,
                  query,
                  timeFilter,
                });
              } else if (
                finalText.toLowerCase().includes("cannot") ||
                finalText.toLowerCase().includes("unable")
              ) {
                sendEvent({
                  type: "result",
                  success: false,
                  error: finalText.slice(0, 300),
                });
              } else {
                sendEvent({
                  type: "result",
                  success: false,
                  error: "Could not generate a valid query",
                });
              }
              break;
            }
          }
        }
      } catch (error) {
        sendEvent({
          type: "result",
          success: false,
          error: error instanceof Error ? error.message : "An error occurred",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Extract a SQL query from the AI response text
 */
function extractQueryFromText(text: string): string | null {
  // Try to extract from code block first
  const codeBlockMatch = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find a SELECT statement
  const selectMatch = text.match(/SELECT[\s\S]+?(?:LIMIT\s+\d+|;|$)/i);
  if (selectMatch) {
    return selectMatch[0].trim().replace(/;$/, "");
  }

  return null;
}

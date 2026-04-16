import { openai } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { inflate } from "node:zlib";
import { promisify } from "node:util";

const inflateAsync = promisify(inflate);
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";

const RequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(1000),
  taskIdentifier: z.string().max(256),
  payloadSchema: z.string().max(50_000).optional(),
  currentPayload: z.string().max(50_000).optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const formData = await request.formData();
  const submission = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!submission.success) {
    return new Response(
      JSON.stringify({ type: "result", success: false, error: "Invalid request data" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response(
      JSON.stringify({ type: "result", success: false, error: "Project not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response(
      JSON.stringify({ type: "result", success: false, error: "Environment not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({
        type: "result",
        success: false,
        error: "OpenAI API key is not configured",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { prompt, taskIdentifier, payloadSchema, currentPayload } = submission.data;

  logger.info("[AI payload] Generating payload", {
    taskIdentifier,
    hasPayloadSchema: !!payloadSchema,
    hasCurrentPayload: !!currentPayload,
    promptLength: prompt.length,
  });

  const systemPrompt = buildSystemPrompt(taskIdentifier, payloadSchema, currentPayload);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: {
        type: string;
        content?: string;
        success?: boolean;
        payload?: string;
        error?: string;
      }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const result = streamText({
          model: openai(env.AI_RUN_FILTER_MODEL ?? "gpt-5-mini"),
          temperature: 1,
          abortSignal: getRequestAbortSignal(),
          system: systemPrompt,
          prompt,
          tools: {
            getTaskSourceCode: tool({
              description:
                "Look up the source code of the task to understand what payload shape it expects. Use this when there is no JSON Schema available and you need to infer the payload structure from the task implementation.",
              parameters: z.object({}),
              execute: async () => {
                return getTaskSourceCode(environment.id, environment.type, taskIdentifier);
              },
            }),
          },
          maxSteps: 3,
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              sendEvent({ type: "thinking", content: part.textDelta });
              break;
            }
            case "tool-call": {
              sendEvent({
                type: "thinking",
                content: "\n\nLooking up task source code...\n\n",
              });
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
          }
        }

        // Extract JSON from the final aggregated text (across all steps)
        const finalText = await result.text;
        const payload = extractJsonFromText(finalText);

        if (payload) {
          sendEvent({ type: "result", success: true, payload });
        } else {
          sendEvent({
            type: "result",
            success: false,
            error: "Could not generate a valid JSON payload",
          });
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

async function getTaskSourceCode(
  environmentId: string,
  environmentType: string,
  taskIdentifier: string
): Promise<string> {
  try {
    logger.info("[AI payload] Looking up task source code", {
      taskIdentifier,
      environmentId,
      environmentType,
    });

    const task =
      environmentType !== "DEVELOPMENT"
        ? await getTaskFromDeployment(environmentId, taskIdentifier)
        : await $replica.backgroundWorkerTask.findFirst({
            where: { slug: taskIdentifier, runtimeEnvironmentId: environmentId },
            orderBy: { createdAt: "desc" },
            select: { fileId: true },
          });

    if (!task?.fileId) {
      logger.info("[AI payload] No fileId found for task", { taskIdentifier });
      return "Source code not available for this task.";
    }

    const file = await $replica.backgroundWorkerFile.findUnique({
      where: { id: task.fileId },
      select: { contents: true, filePath: true },
    });

    if (!file) {
      logger.info("[AI payload] File record not found", { taskIdentifier, fileId: task.fileId });
      return "Source code not available for this task.";
    }

    // File contents are zlib-deflated then base64-encoded by the CLI,
    // stored as Buffer.from(base64String) in Prisma Bytes
    const base64 = Buffer.from(file.contents).toString("utf-8");
    const decompressed = (await inflateAsync(Buffer.from(base64, "base64"))).toString("utf-8");

    logger.info("[AI payload] Found task source code", {
      taskIdentifier,
      filePath: file.filePath,
      contentLength: decompressed.length,
    });

    return `File: ${file.filePath}\n\n${decompressed}`;
  } catch (error) {
    logger.error("[AI payload] Failed to retrieve task source code", {
      taskIdentifier,
      error: error instanceof Error ? error.message : String(error),
    });
    return "Failed to retrieve task source code.";
  }
}

async function getTaskFromDeployment(environmentId: string, taskIdentifier: string) {
  const deployment = await findCurrentWorkerDeployment({ environmentId });
  if (!deployment?.worker) return null;

  const task = deployment.worker.tasks.find((t) => t.slug === taskIdentifier);
  if (!task) return null;

  return { fileId: task.fileId };
}

function buildSystemPrompt(
  taskIdentifier: string,
  payloadSchema?: string,
  currentPayload?: string
): string {
  let prompt = `You are a JSON payload generator for a Trigger.dev task with id "${taskIdentifier}".

Your job is to generate a valid JSON payload that can be used to test this task. Return ONLY valid JSON wrapped in a \`\`\`json code block. Do not include any explanation outside the code block.

Requirements:
- Generate realistic, meaningful example data
- All string values should be plausible (real-looking names, emails, URLs, etc.)
- Number values should be reasonable for their context
- The JSON must be valid and parseable`;

  if (payloadSchema) {
    prompt += `

The task has the following JSON Schema that the payload must conform to:
\`\`\`json
${payloadSchema}
\`\`\`

Generate a payload that strictly conforms to this schema, respecting all type constraints, required fields, enums, formats, and validation rules.`;
  } else {
    prompt += `

No JSON Schema is available for this task. Use the getTaskSourceCode tool to look up the task's source code file.

IMPORTANT instructions for reading the source code:
- The file may contain multiple task definitions. Find the one with id "${taskIdentifier}".
- Look at the \`run\` function's payload parameter type to determine the expected shape.
- If the payload is typed as \`any\`, \`unknown\`, or has no type annotation, check how payload properties are actually accessed inside the \`run\` function body to infer the structure.
- If the payload type is explicitly defined (e.g. \`{ name: string, count: number }\`), use that exactly.
- If the payload is typed as \`any\` and is never accessed or destructured in the function body, the task likely accepts any payload. In that case generate a simple \`{}\` empty object.
- Do NOT invent complex payload structures that aren't supported by the code. Only include fields you can confirm from the type annotation or actual usage in the function body.`;
  }

  if (currentPayload) {
    prompt += `

The current payload in the editor is:
\`\`\`json
${currentPayload}
\`\`\`

Use this as context for what the user might want, but generate a new payload based on the user's prompt.`;
  }

  return prompt;
}

function extractJsonFromText(text: string): string | null {
  // Try to extract from code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    try {
      // Validate and pretty-print
      return JSON.stringify(JSON.parse(candidate), null, 2);
    } catch {
      // Fall through
    }
  }

  // Try to find a JSON object or array
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.stringify(JSON.parse(jsonMatch[1]), null, 2);
    } catch {
      // Fall through
    }
  }

  return null;
}

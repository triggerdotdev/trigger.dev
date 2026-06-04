import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolContext } from "../types";

const inflateAsync = promisify(inflate);

type GeneratePayloadResult =
  | { success: true; taskIdentifier: string; payload: string; schemaSource: "schema" | "source" }
  | { success: false; error: string };

// Mirrors the Test page's AI payload generation
// (resources…test.ai-generate-payload.tsx) but returns the payload as a value
// so the assistant can fill the editor and/or feed it into runTestTask.
export async function generatePayloadForTask(
  ctx: ToolContext,
  taskIdentifier: string,
  instruction?: string
): Promise<GeneratePayloadResult> {
  const { env } = await import("~/env.server");
  const { $replica } = await import("~/db.server");
  const { resolveTestEnvironment } = await import("./resolve-environment");

  if (!env.OPENAI_API_KEY) {
    return { success: false, error: "OpenAI API key is not configured" };
  }

  const environment = await resolveTestEnvironment(ctx);

  const task = await $replica.backgroundWorkerTask.findFirst({
    where: { slug: taskIdentifier, runtimeEnvironmentId: environment.id },
    orderBy: { createdAt: "desc" },
    select: { payloadSchema: true },
  });

  const payloadSchema =
    task?.payloadSchema != null ? JSON.stringify(task.payloadSchema) : undefined;

  const system = buildSystemPrompt(taskIdentifier, payloadSchema);
  const prompt =
    instruction && instruction.trim().length > 0
      ? instruction.trim()
      : "Generate a simple valid payload to test this task with.";

  const result = await generateText({
    model: openai(env.AI_RUN_FILTER_MODEL ?? "gpt-5-mini"),
    temperature: 1,
    system,
    prompt,
    tools: {
      getTaskSourceCode: tool({
        description:
          "Look up the source code of the task to understand the payload shape it expects. Use " +
          "when there is no JSON Schema available.",
        inputSchema: z.object({}),
        execute: async () =>
          getTaskSourceCode(environment.id, environment.type, taskIdentifier),
      }),
    },
    stopWhen: stepCountIs(3),
  });

  const payload = extractJsonFromText(result.text);
  if (!payload) {
    return { success: false, error: "Could not generate a valid JSON payload" };
  }

  return {
    success: true,
    taskIdentifier,
    payload,
    schemaSource: payloadSchema ? "schema" : "source",
  };
}

async function getTaskSourceCode(
  environmentId: string,
  environmentType: string,
  taskIdentifier: string
): Promise<string> {
  try {
    const { $replica } = await import("~/db.server");

    let fileId: string | null | undefined;
    if (environmentType !== "DEVELOPMENT") {
      const { findCurrentWorkerDeployment } = await import(
        "~/v3/models/workerDeployment.server"
      );
      const deployment = await findCurrentWorkerDeployment({ environmentId });
      fileId = deployment?.worker?.tasks.find((t) => t.slug === taskIdentifier)?.fileId;
    } else {
      const task = await $replica.backgroundWorkerTask.findFirst({
        where: { slug: taskIdentifier, runtimeEnvironmentId: environmentId },
        orderBy: { createdAt: "desc" },
        select: { fileId: true },
      });
      fileId = task?.fileId;
    }

    if (!fileId) return "Source code not available for this task.";

    const file = await $replica.backgroundWorkerFile.findUnique({
      where: { id: fileId },
      select: { contents: true, filePath: true },
    });
    if (!file) return "Source code not available for this task.";

    // File contents are zlib-deflated then base64-encoded by the CLI.
    const base64 = Buffer.from(file.contents).toString("utf-8");
    const decompressed = (await inflateAsync(Buffer.from(base64, "base64"))).toString("utf-8");
    return `File: ${file.filePath}\n\n${decompressed}`;
  } catch {
    return "Failed to retrieve task source code.";
  }
}

function buildSystemPrompt(taskIdentifier: string, payloadSchema?: string): string {
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
- If the payload is typed as \`any\`/\`unknown\` or has no annotation, infer the shape from how payload properties are accessed inside the \`run\` body.
- If the payload is typed explicitly (e.g. \`{ name: string, count: number }\`), use that exactly.
- If the payload is never accessed, the task likely accepts any payload — generate a simple \`{}\` object.
- Do NOT invent fields you can't confirm from the type or usage.`;
  }

  return prompt;
}

function extractJsonFromText(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    try {
      return JSON.stringify(JSON.parse(codeBlockMatch[1].trim()), null, 2);
    } catch {
      // fall through
    }
  }
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.stringify(JSON.parse(jsonMatch[1]), null, 2);
    } catch {
      // fall through
    }
  }
  return null;
}

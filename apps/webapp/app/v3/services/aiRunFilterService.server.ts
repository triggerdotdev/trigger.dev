import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

const AIFilterResponseSchema = z.object({
  filters: TaskRunListSearchFilters,
  explanation: z
    .string()
    .describe("A short human-readable explanation of what filters were applied"),
});

export type AIFilterResult =
  | {
      success: true;
      filters: TaskRunListSearchFilters;
      explanation: string;
    }
  | {
      success: false;
      error: string;
      suggestions?: string[];
    };

export async function processAIFilter(
  text: string,
  environmentId: string
): Promise<AIFilterResult> {
  if (!env.OPENAI_API_KEY) {
    return {
      success: false,
      error: "OpenAI API key is not configured",
      suggestions: ["Contact your administrator to configure AI features"],
    };
  }

  try {
    const result = await generateObject({
      model: openai("gpt-4o"),
      schema: AIFilterResponseSchema,
      prompt: `You are an AI assistant that converts natural language descriptions into structured filter parameters for a task run filtering system.

Available filter options:
- statuses: Array of run statuses (PENDING, EXECUTING, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, CANCELED, TIMED_OUT, CRASHED, etc.)
- period: Time period string (e.g., "1h", "7d", "30d", "1y")
- from/to: Unix ms timestamps for specific time ranges. You'll need to use a converter if they give you a date. Today's date is ${new Date().toISOString()}, if they only specify a day use the current month. If they don't specify a year use the current year. If they don't specify a time of day use midnight to midnight.
- tags: Array of tag names to filter by
- tasks: Array of task identifiers to filter by
- machines: Array of machine presets (micro, small, small-2x, medium, large, xlarge, etc.)
- queues: Array of queue names to filter by
- versions: Array of version identifiers to filter by
- rootOnly: Boolean to show only root runs (not child runs)
- runId: Array of specific run IDs to filter by
- batchId: Specific batch ID to filter by
- scheduleId: Specific schedule ID to filter by

Common patterns to recognize:
- "failed runs" → statuses: ["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"].
- If they say "only failed" then only use "COMPLETED_WITH_ERRORS".
- "successful runs" → statuses: ["COMPLETED_SUCCESSFULLY"]
- "running runs" → statuses: ["EXECUTING", "RETRYING_AFTER_FAILURE", "WAITING_TO_RESUME"]
- "pending runs" → statuses: ["PENDING", "PENDING_VERSION", "DELAYED"]
- "past 7 days" → period: "7d"
- "last hour" → period: "1h"
- "this month" → period: "30d"
- "with tag X" → tags: ["X"]
- "from task Y" → tasks: ["Y"]
- "using large machine" → machines: ["large-1x", "large-2x"]
- "root only" → rootOnly: true

Unless they specify they only want root runs, set rootOnly to false.

Convert the following natural language description into structured filters:

"${text}"

Return only the filters that are explicitly mentioned or can be reasonably inferred. If the description is unclear or doesn't match any known patterns, return an empty filters object and explain why in the explanation field.`,
    });

    return {
      success: true,
      filters: result.object.filters,
      explanation: result.object.explanation,
    };
  } catch (error) {
    logger.error("AI filter processing failed", { error, text, environmentId });

    return {
      success: false,
      error: "Failed to process AI filter request",
      suggestions: [
        "Try being more specific about what you want to filter",
        "Use common terms like 'failed runs', 'last 7 days', 'with tag X'",
        "Check that your description is clear and unambiguous",
      ],
    };
  }
}

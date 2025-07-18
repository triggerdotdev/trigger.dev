import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { RunTagListPresenter } from "~/presenters/v3/RunTagListPresenter.server";
import { VersionListPresenter } from "~/presenters/v3/VersionListPresenter.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
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
      suggestions: string;
    };

export async function processAIFilter(
  text: string,
  environment: AuthenticatedEnvironment
): Promise<AIFilterResult> {
  if (!env.OPENAI_API_KEY) {
    return {
      success: false,
      error: "OpenAI API key is not configured",
      suggestions: "Contact your administrator to configure AI features",
    };
  }

  try {
    // Create presenter instances for lookups
    const tagPresenter = new RunTagListPresenter();
    const versionPresenter = new VersionListPresenter();
    const queuePresenter = new QueueListPresenter();

    const result = await generateText({
      model: openai("gpt-4o"),
      experimental_output: Output.object({ schema: AIFilterResponseSchema }),
      tools: {
        lookupTags: {
          description: "Look up available tags in the environment",
          parameters: z.object({
            query: z.string().optional().describe("Optional search query to filter tags"),
          }),
          execute: async ({ query }) => {
            const tags = await tagPresenter.call({
              projectId: environment.projectId,
              name: query,
              page: 1,
              pageSize: 50,
            });
            return {
              tags: tags.tags.map((tag) => tag.name),
              total: tags.tags.length,
            };
          },
        },
        lookupVersions: {
          description:
            "Look up available versions in the environment. If you specify `isCurrent` it will return a single version string if it finds one. Otherwise it will return an array of version strings.",
          parameters: z.object({
            isCurrent: z.boolean().optional().describe("If true, only return the current version"),
            versionPrefix: z
              .string()
              .optional()
              .describe(
                "Optional version name to filter (e.g. 20250701.1), it uses contains to compare. Don't pass `latest` or `current`, the query has to be in the reverse date format specified.  Leave out to get all recent versions."
              ),
          }),
          execute: async ({ versionPrefix, isCurrent }) => {
            const versions = await versionPresenter.call({
              environment,
              query: versionPrefix ? versionPrefix : undefined,
            });

            if (isCurrent) {
              const currentVersion = versions.versions.find((v) => v.isCurrent);
              if (currentVersion) {
                return {
                  version: currentVersion.version,
                };
              }

              if (versions.versions.length > 0) {
                return {
                  version: versions.versions.at(0)?.version,
                };
              }
            }

            return {
              versions: versions.versions.map((v) => v.version),
            };
          },
        },
        lookupQueues: {
          description: "Look up available queues in the environment",
          parameters: z.object({
            query: z.string().optional().describe("Optional search query to filter queues"),
            type: z
              .enum(["task", "custom"])
              .optional()
              .describe("Filter by queue type, only do this if the user specifies it explicitly."),
          }),
          execute: async ({ query, type }) => {
            const queues = await queuePresenter.call({
              environment,
              query,
              page: 1,
              type,
            });
            return {
              queues: queues.success ? queues.queues.map((q) => q.name) : [],
              total: queues.success ? queues.queues.length : 0,
            };
          },
        },
        lookupTasks: {
          description:
            "Look up available tasks in the environment. It will return each one. The `slug` is used for the filtering. You also get the triggerSource which is either `STANDARD` or `SCHEDULED`",
          parameters: z.object({}),
          execute: async () => {
            const tasks = await getAllTaskIdentifiers($replica, environment.id);
            return {
              tasks,
              total: tasks.length,
            };
          },
        },
      },
      prompt: `You are an AI assistant that converts natural language descriptions into structured filter parameters for a task run filtering system.

Available filter options:
- statuses: Array of run statuses (PENDING, EXECUTING, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, CANCELED, TIMED_OUT, CRASHED, etc.)
- period: Time period string (e.g., "1h", "7d", "30d", "1y")
- from/to: Unix ms timestamps for specific time ranges. You'll need to use a converter if they give you a date. Today's date is ${new Date().toISOString()}, if they only specify a day use the current month. If they don't specify a year use the current year. If they don't specify a time of day use midnight to midnight.
- tags: Array of tag names to filter by. Use the lookupTags tool to get the tags.
- tasks: Array of task identifiers to filter by. Use the lookupTasks tool to get the tasks.
- machines: Array of machine presets (micro, small, small-2x, medium, large, xlarge, etc.)
- queues: Array of queue names to filter by. Use the lookupQueues tool to get the queues.
- versions: Array of version identifiers to filter by. Use the lookupVersions tool to get the versions. The "latest" version will be the first returned. The "current" or "deployed" version will have isCurrent set to true.
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

Use the available tools to look up actual tags, versions, queues, and tasks in the environment when the user mentions them. This will help you provide accurate filter values.

Unless they specify they only want root runs, set rootOnly to false.

Convert the following natural language description into structured filters:

"${text}"

Return only the filters that are explicitly mentioned or can be reasonably inferred. If the description is unclear or doesn't match any known patterns, return an empty filters object and explain why in the explanation field.`,
    });

    return {
      success: true,
      filters: result.experimental_output.filters,
      explanation: result.experimental_output.explanation,
    };
  } catch (error) {
    logger.error("AI filter processing failed", { error, text, environmentId: environment.id });

    return {
      success: false,
      error: "Failed to process AI filter request",
      suggestions:
        "Try being more specific about what you want to filter. Use common terms like 'failed runs', 'last 7 days', 'with tag X'. Check that your description is clear and unambiguous",
    };
  }
}

import { openai } from "@ai-sdk/openai";
import { type TaskTriggerSource } from "@trigger.dev/database";
import { generateText, Output, tool } from "ai";
import { z } from "zod";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { logger } from "~/services/logger.server";

const AIFilters = TaskRunListSearchFilters.omit({
  environments: true,
  from: true,
  to: true,
}).extend({
  from: z.string().optional().describe("The ISO datetime to filter from"),
  to: z.string().optional().describe("The ISO datetime to filter to"),
});

const AIFilterResponseSchema = z
  .discriminatedUnion("success", [
    z.object({
      success: z.literal(true),
      filters: AIFilters,
    }),
    z.object({
      success: z.literal(false),
      error: z.string().describe("A short human-readable error message"),
    }),
  ])
  .describe("The response from the AI filter service");

export interface QueryQueues {
  query(
    search: string | undefined,
    type: "task" | "custom" | undefined
  ): Promise<{
    queues: string[];
  }>;
}

export interface QueryVersions {
  query(
    versionPrefix: string | undefined,
    isCurrent: boolean | undefined
  ): Promise<
    | {
        versions: string[];
      }
    | {
        version: string;
      }
  >;
}

export interface QueryTags {
  query(search: string | undefined): Promise<{
    tags: string[];
  }>;
}

export interface QueryTasks {
  query(): Promise<{
    tasks: { slug: string; triggerSource: TaskTriggerSource }[];
  }>;
}

export type AIFilterResult =
  | {
      success: true;
      filters: TaskRunListSearchFilters;
    }
  | {
      success: false;
      error: string;
    };

export class AIRunFilterService {
  constructor(
    private readonly queryFns: {
      queryTags: QueryTags;
      queryVersions: QueryVersions;
      queryQueues: QueryQueues;
      queryTasks: QueryTasks;
    }
  ) {}

  async call(text: string, environmentId: string): Promise<AIFilterResult> {
    try {
      const result = await generateText({
        model: openai("gpt-4o-mini"),
        experimental_output: Output.object({ schema: AIFilterResponseSchema }),
        tools: {
          lookupTags: tool({
            description: "Look up available tags in the environment",
            parameters: z.object({
              query: z.string().optional().describe("Optional search query to filter tags"),
            }),
            execute: async ({ query }) => {
              return await this.queryFns.queryTags.query(query);
            },
          }),
          lookupVersions: tool({
            description:
              "Look up available versions in the environment. If you specify `isCurrent` it will return a single version string if it finds one. Otherwise it will return an array of version strings.",
            parameters: z.object({
              isCurrent: z
                .boolean()
                .optional()
                .describe("If true, only return the current version"),
              versionPrefix: z
                .string()
                .optional()
                .describe(
                  "Optional version name to filter (e.g. 20250701.1), it uses contains to compare. Don't pass `latest` or `current`, the query has to be in the reverse date format specified.  Leave out to get all recent versions."
                ),
            }),
            execute: async ({ versionPrefix, isCurrent }) => {
              return await this.queryFns.queryVersions.query(versionPrefix, isCurrent);
            },
          }),
          lookupQueues: tool({
            description: "Look up available queues in the environment",
            parameters: z.object({
              query: z.string().optional().describe("Optional search query to filter queues"),
              type: z
                .enum(["task", "custom"])
                .optional()
                .describe(
                  "Filter by queue type, only do this if the user specifies it explicitly."
                ),
            }),
            execute: async ({ query, type }) => {
              return await this.queryFns.queryQueues.query(query, type);
            },
          }),
          lookupTasks: tool({
            description:
              "Look up available tasks in the environment. It will return each one. The `slug` is used for the filtering. You also get the triggerSource which is either `STANDARD` or `SCHEDULED`",
            parameters: z.object({}),
            execute: async () => {
              return await this.queryFns.queryTasks.query();
            },
          }),
        },
        maxSteps: 5,
        system: `You are an AI assistant that converts natural language descriptions into structured filter parameters for a task run filtering system.
  
  Available filter options:
  - statuses: Array of run statuses (PENDING, EXECUTING, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, CANCELED, TIMED_OUT, CRASHED, etc.)
  - period: Time period string (e.g., "1h", "7d", "30d", "1y")
  - from/to: ISO date string. Today's date is ${new Date().toISOString()}, if they only specify a day use the current month. If they don't specify a year use the current year. If they don't specify a time of day use midnight.
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
  - "runs not dequeued yet" → statuses: ["PENDING", "PENDING_VERSION", "DELAYED"]
  - If they say "only failed" then only use "COMPLETED_WITH_ERRORS".
  - "successful runs" → statuses: ["COMPLETED_SUCCESSFULLY"]
  - "running runs" → statuses: ["EXECUTING", "RETRYING_AFTER_FAILURE", "WAITING_TO_RESUME"]
  - "pending runs" → statuses: ["PENDING", "PENDING_VERSION", "DELAYED"]
  - "past 7 days" → period: "7d"
  - "last hour" → period: "1h"
  - "this month" → period: "30d"
  - "June 16" -> return a from/to filter.
  - "with tag X" → tags: ["X"]
  - "from task Y" → tasks: ["Y"]
  - "using large machine" → machines: ["large-1x", "large-2x"]
  - "root only" → rootOnly: true
  
  Use the available tools to look up actual tags, versions, queues, and tasks in the environment when the user mentions them. This will help you provide accurate filter values.
  
  Unless they specify they only want root runs, set rootOnly to false.
  
  IMPORTANT: Return ONLY the filters that are explicitly mentioned or can be reasonably inferred. If the description is unclear or doesn't match any known patterns, return an empty filters object {} and explain why in the explanation field.
  
  The filters object should only contain the fields that are actually being filtered. Do not include fields with empty arrays or undefined values.
  
  CRITICAL: The response must be a valid JSON object with exactly this structure:
  {
    "success": true,
    "filters": {
      // only include fields that have actual values
    },
    "explanation": "string explaining what filters were applied"
  }
  
  or if you can't figure out the filters then return:
  {
    "success": false,
    "error": "<short human understandable suggestion>"
  }
  
  Make the error no more than 8 words.
  `,
        prompt: text,
        experimental_telemetry: {
          isEnabled: true,
          metadata: {
            environmentId,
          },
        },
      });

      if (!result.experimental_output.success) {
        return {
          success: false,
          error: result.experimental_output.error,
        };
      }

      // Validate the filters against the schema to catch any issues
      const validationResult = AIFilters.safeParse(result.experimental_output.filters);
      if (!validationResult.success) {
        logger.error("AI filter validation failed", {
          errors: validationResult.error.errors,
          filters: result.experimental_output.filters,
        });

        return {
          success: false,
          error: "AI response validation failed",
        };
      }

      return {
        success: true,
        filters: {
          ...validationResult.data,
          from: validationResult.data.from
            ? new Date(validationResult.data.from).getTime()
            : undefined,
          to: validationResult.data.to ? new Date(validationResult.data.to).getTime() : undefined,
        },
      };
    } catch (error) {
      logger.error("AI filter processing failed", {
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        text,
        environmentId,
      });

      // If it's a schema validation error, provide more specific feedback
      if (error instanceof Error && error.message.includes("schema")) {
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

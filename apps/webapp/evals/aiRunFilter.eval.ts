import { evalite } from "evalite";
import { Levenshtein } from "autoevals";
import {
  AIRunFilterService,
  type QueryQueues,
  type QueryTags,
  type QueryTasks,
  type QueryVersions,
} from "~/v3/services/aiRunFilterService.server";
import dotenv from "dotenv";
import { traceAISDKModel } from "evalite/ai-sdk";
import { openai } from "@ai-sdk/openai";

dotenv.config({ path: "../../.env" });

const queryTags: QueryTags = {
  query: async (search) => {
    return {
      tags: ["user_1", "user_2", "org_1", "org_2"],
    };
  },
};

const queryVersions: QueryVersions = {
  query: async (versionPrefix, isCurrent) => {
    if (isCurrent) {
      return {
        version: "20250721.1",
      };
    }

    return {
      versions: ["20250721.1", "20250720.2", "20250720.1"],
    };
  },
};

const queryQueues: QueryQueues = {
  query: async (query, type) => {
    return {
      queues: ["shared", "paid"],
    };
  },
};

const queryTasks: QueryTasks = {
  query: async () => {
    return {
      tasks: [
        { slug: "email-sender", triggerSource: "STANDARD" },
        { slug: "email-sender-scheduled", triggerSource: "SCHEDULED" },
      ],
    };
  },
};

evalite("AI Run Filter", {
  data: async () => {
    return [
      // Basic status filtering
      {
        input: "Completed runs",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_SUCCESSFULLY"],
          },
        }),
      },
      {
        input: "Failed runs",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"],
          },
        }),
      },
      {
        input: "Executing runs",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["EXECUTING", "RETRYING_AFTER_FAILURE", "WAITING_TO_RESUME"],
          },
        }),
      },
      // Time filters
      {
        input: "Runs from the past 7 days",
        expected: JSON.stringify({
          success: true,
          filters: {
            period: "7d",
          },
        }),
      },
      {
        input: "Runs from the last hour",
        expected: JSON.stringify({
          success: true,
          filters: {
            period: "1h",
          },
        }),
      },
      {
        input: "Runs from this month",
        expected: JSON.stringify({
          success: true,
          filters: {
            period: "30d",
          },
        }),
      },
      {
        input: "June 16",
        expected: JSON.stringify({
          success: true,
          filters: {
            from: new Date("2025-06-16").getTime(),
            to: new Date("2025-06-17").getTime(),
          },
        }),
      },
      // Combined filters
      {
        input: "Failed runs from the past week",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"],
            period: "7d",
          },
        }),
      },
      {
        input: "Successful runs from the last 24 hours",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_SUCCESSFULLY"],
            period: "1d",
          },
        }),
      },
      // Root-only filtering
      {
        input: "Root runs only",
        expected: JSON.stringify({
          success: true,
          filters: {
            rootOnly: true,
          },
        }),
      },
      {
        input: "Failed root runs from yesterday",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"],
            rootOnly: true,
            period: "1d",
          },
        }),
      },
      // Machine filtering
      {
        input: "Runs using large machines",
        expected: JSON.stringify({
          success: true,
          filters: {
            machines: ["large-1x", "large-2x"],
          },
        }),
      },
      // Edge cases and error handling
      {
        input: "Runs with tag production",
        expected: JSON.stringify({
          success: true,
          filters: {
            tags: ["production"],
          },
        }),
      },
      {
        input: "Runs from task email-sender",
        expected: JSON.stringify({
          success: true,
          filters: {
            tasks: ["email-sender"],
          },
        }),
      },
      {
        input: "Runs in the shared queue",
        expected: JSON.stringify({
          success: true,
          filters: {
            queues: ["shared"],
          },
        }),
      },
      // Complex combinations
      {
        input: "Failed production runs from the past 3 days using large machines",
        expected: JSON.stringify({
          success: true,
          filters: {
            statuses: ["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT", "SYSTEM_FAILURE"],
            tags: ["production"],
            period: "3d",
            machines: ["large-1x", "large-2x"],
          },
        }),
      },
      // Ambiguous cases that should return errors
      {
        input: "Show me something",
        expected: JSON.stringify({
          success: false,
          error: "Unclear what to filter",
        }),
      },
      {
        input: "Runs with unknown status",
        expected: JSON.stringify({
          success: false,
          error: "Unknown status specified",
        }),
      },
    ];
  },
  task: async (input) => {
    const service = new AIRunFilterService(
      {
        queryTags,
        queryVersions,
        queryQueues,
        queryTasks,
      },
      traceAISDKModel(openai("gpt-4o-mini"))
    );

    const result = await service.call(input, "123456");
    return JSON.stringify(result);
  },
  scorers: [Levenshtein],
});

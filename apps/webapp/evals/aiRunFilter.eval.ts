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
        { slug: "task1", triggerSource: "STANDARD" },
        { slug: "task2", triggerSource: "SCHEDULED" },
      ],
    };
  },
};

evalite("AI Run Filter", {
  data: async () => {
    return [
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
    ];
  },
  task: async (input) => {
    const service = new AIRunFilterService({
      queryTags,
      queryVersions,
      queryQueues,
      queryTasks,
    });

    const result = await service.call(input, "123456");
    return JSON.stringify(result);
  },
  scorers: [Levenshtein],
});

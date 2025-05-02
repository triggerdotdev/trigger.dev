import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { ai } from "@trigger.dev/sdk/ai";
import { logger, metadata, schemaTask, tasks, wait } from "@trigger.dev/sdk/v3";
import { sql } from "@vercel/postgres";
import { streamText, TextStreamPart, tool } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { sendSQLApprovalMessage } from "../lib/slack";
import { crawler } from "./crawler";
import { chartTool } from "./sandbox";
import { QueryApproval } from "./schemas";

const queryApprovalTask = schemaTask({
  id: "query-approval",
  description: "Get approval for a SQL query from an admin",
  schema: z.object({
    userId: z.string().describe("The user_id to get approval for"),
    input: z.string().describe("The input to get approval for"),
    query: z.string().describe("The SQL query to execute"),
  }),
  run: async ({ userId, input, query }) => {
    const token = await wait.createToken({
      tags: [`user:${userId}`, "approval"],
      timeout: "5m", // timeout in 5 minutes
    });

    await sendSQLApprovalMessage({
      query,
      userId,
      tokenId: token.id,
      publicAccessToken: token.publicAccessToken,
      input,
    });

    const result = await wait.forToken<QueryApproval>(token);

    // result.ok === false if the token timed out
    if (!result.ok) {
      logger.debug("queryApproval: token timed out");

      return {
        approved: false,
      };
    } else {
      return result.output;
    }
  },
});

const queryApproval = ai.tool(queryApprovalTask);

const executeSql = tool({
  description: "Use this tool to execute a SQL query",
  parameters: z.object({
    query: z.string().describe("The SQL query to execute"),
  }),
  execute: async ({ query }) => {
    // DANGER: This is a dangerous tool, it can execute arbitrary SQL queries.
    const result = await sql.query(query);

    return result.rows;
  },
});

const generateId = tool({
  description: "Use this tool to generate a unique ID for a todo",
  parameters: z.object({
    prefix: z.string().describe("The prefix for the ID (defaults to 'todo')").default("todo"),
  }),
  execute: async ({ prefix }) => {
    return `${prefix}_${nanoid(12)}`;
  },
});

const getUserTodos = tool({
  description: "Use this tool to get all todos for a user",
  parameters: z.object({
    userId: z.string().describe("The user_id to get todos for"),
  }),
  execute: async ({ userId }) => {
    const result = await sql`SELECT * FROM todos WHERE user_id = ${userId}`;

    return result.rows;
  },
});

const getUserId = tool({
  description: "Use this tool to get the user_id for the current user",
  parameters: z.object({}),
  execute: async () => {
    const userId = metadata.get("user_id");

    if (!userId) {
      throw new Error("No user_id found");
    }

    return userId;
  },
});

export const todoChat = schemaTask({
  id: "todo-chat",
  description: "Chat with the todo app",
  schema: z.object({
    input: z
      .string()
      .describe(
        "The input to chat with the todo app. Will be a request to read or update the todo list."
      ),
    userId: z.string(),
  }),
  run: async ({ input, userId }, { signal }) => {
    metadata.set("user_id", userId);

    const system = `
      You are a SQL (postgres) expert who can turn natural language descriptions for a todo app 
      into a SQL query which can then be executed against a SQL database. Here is the schema:
      
      CREATE TABLE IF NOT EXISTS todos (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 3,
        due_date TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE,
        tags TEXT[], -- Array of tags
        assigned_to VARCHAR(255)
      );

      Only Create, Read, Update, and Delete operations are allowed.

      The output will be a SQL query.

      If the query produced is a mutation, you will need to get approval first from an admin using the queryApproval tool. 
      If the queryApproval tool returns false, you will need to stop and return an error message.
      If the queryApproval tool returns true, you will need to execute the query using the executeSql tool.

      The executeSql tool will return the results of the query.

      The current time is ${new Date().toISOString()}.

      When creating a todo, you'll need to generate a unique ID for the todo, using the generateId tool.
      For updates, you'll need to use the getUserTodos tool to find the todo first.

      IMPORTANT: Don't ask the user to provide any more information to help you generate the SQL query, do your best to generate the query based on the input alone.

      After successfully executing a mutation query, get the latest user todos and summarize them along with what has been updated.
      After successfully executing a read query, summarize the results in a human readable format.

      If the user specifies a URL, you can use the crawler tool to crawl the URL and return the markdown, helping inform the SQL query.
    `;

    const prompt = input;

    const chunks: TextStreamPart<TOOLS>[] = [];

    const result = streamText({
      model: getModel(),
      system,
      prompt,
      maxSteps: 10,
      tools: {
        queryApproval,
        executeSql,
        generateId,
        getUserTodos,
        crawler,
        getUserId,
        chart: chartTool,
      },
      experimental_telemetry: {
        isEnabled: true,
      },
      abortSignal: signal,
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      },
    });

    const stream = await metadata.stream("fullStream", result.fullStream);

    const textParts = [];

    for await (const part of stream) {
      if (part.type === "text-delta") {
        textParts.push(part.textDelta);
      }
    }

    return textParts.join("");
  },
});

export type TOOLS = {
  queryApproval: typeof queryApproval;
  executeSql: typeof executeSql;
  generateId: typeof generateId;
  getUserTodos: typeof getUserTodos;
  crawler: typeof crawler;
  getUserId: typeof getUserId;
  chart: typeof chartTool;
};

export type STREAMS = {
  fullStream: TextStreamPart<TOOLS>;
};

const CHAT_PROVIDER: "openai" | "anthropic" = "openai";

function getModel() {
  if (CHAT_PROVIDER === "openai") {
    return openai("gpt-4o");
  } else {
    return anthropic("claude-3-5-sonnet-latest");
  }
}

export const interruptibleChat = schemaTask({
  id: "interruptible-chat",
  description: "Chat with the AI",
  schema: z.object({
    prompt: z.string().describe("The prompt to chat with the AI"),
  }),
  run: async ({ prompt }, { signal }) => {
    const chunks: TextStreamPart<{}>[] = [];

    // 👇 This is a global onCancel hook, but it's inside of the run function
    tasks.onCancel(async () => {
      logger.info("interruptible-chat: task cancelled with chunks", { chunks });
    });

    try {
      const result = streamText({
        model: getModel(),
        prompt,
        experimental_telemetry: {
          isEnabled: true,
        },
        tools: {},
        abortSignal: signal,
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        onError: ({ error }) => {
          if (error instanceof Error && error.name === "AbortError") {
            logger.info("interruptible-chat: streamText aborted", { error });
          } else {
            logger.error("interruptible-chat: streamText error", { error });
          }
        },
        onFinish: ({ finishReason }) => {
          logger.info("interruptible-chat: streamText finished", { finishReason });
        },
      });

      const textParts = [];

      for await (const part of result.textStream) {
        textParts.push(part);
      }

      return textParts.join("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.info("interruptible-chat: streamText aborted (inside catch)", { error });
      } else {
        logger.error("interruptible-chat: streamText error (inside catch)", { error });
      }
    }
  },
  onCancel: async ({ runPromise }) => {
    //   👇 output is typed as `string` because that's the return type of the run function
    const output = await runPromise;

    logger.info("interruptible-chat: task cancelled with output", { output });
  },
});

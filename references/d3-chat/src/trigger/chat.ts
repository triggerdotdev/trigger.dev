import { openai } from "@ai-sdk/openai";
import { logger, metadata, schemaTask, wait } from "@trigger.dev/sdk/v3";
import { sql } from "@vercel/postgres";
import { streamText, TextStreamPart } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { QueryApproval } from "./schemas";
import { tool } from "ai";
import { ai } from "@trigger.dev/sdk/ai";
import { python } from "@trigger.dev/python";
import { sendSQLApprovalMessage } from "../lib/slack";

const crawlerTask = schemaTask({
  id: "crawler",
  description: "Crawl a URL and return the markdown",
  schema: z.object({
    url: z.string().describe("The URL to crawl"),
  }),
  run: async ({ url }) => {
    const results = await python.runScript("./src/trigger/python/crawler.py", [url]);

    return results.stdout;
  },
});

const crawler = ai.tool(crawlerTask);

const queryApprovalTask = schemaTask({
  id: "query-approval",
  description: "Get approval for a SQL query from an admin",
  schema: z.object({
    userId: z.string().describe("The user_id to get approval for"),
    input: z.string().describe("The input to get approval for"),
    query: z.string().describe("The SQL query to execute"),
  }),
  run: async ({ userId, input, query }) => {
    const toolOptions = ai.currentToolOptions();

    if (toolOptions) {
      logger.info("tool options", {
        toolOptions,
      });
    }

    const token = await wait.createToken({
      tags: [`user:${userId}`, "approval"],
      timeout: "1m",
    });

    logger.info("waiting for approval", {
      query,
    });

    await sendSQLApprovalMessage({
      query,
      userId,
      tokenId: token.id,
      publicAccessToken: token.publicAccessToken,
      input,
    });

    const result = await wait.forToken<QueryApproval>(token);

    if (!result.ok) {
      return {
        approved: false,
      };
    } else {
      if (result.output.approved) {
        logger.info("query approved", {
          query,
        });
      } else {
        logger.warn("query denied", {
          query,
        });
      }

      return {
        approved: result.output.approved,
      };
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

export type TOOLS = {
  queryApproval: typeof queryApproval;
  executeSql: typeof executeSql;
  generateId: typeof generateId;
  getUserTodos: typeof getUserTodos;
  crawler: typeof crawler;
  getUserId: typeof getUserId;
};

export type STREAMS = {
  fullStream: TextStreamPart<TOOLS>;
};

export const todoChat = schemaTask({
  id: "todo-chat",
  description: "Chat with the todo app",
  schema: z.object({
    model: z.string().default("gpt-4o"),
    input: z
      .string()
      .describe(
        "The input to chat with the todo app. Will be a request to read or update the todo list."
      ),
    userId: z.string(),
  }),
  run: async ({ model, input, userId }) => {
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

    const result = streamText({
      model: openai(model),
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
      },
      experimental_telemetry: {
        isEnabled: true,
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

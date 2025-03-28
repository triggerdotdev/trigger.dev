import { openai } from "@ai-sdk/openai";
import { logger, metadata, schemaTask, wait } from "@trigger.dev/sdk/v3";
import { sql } from "@vercel/postgres";
import { streamText } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { QueryApproval } from "./schemas";

export const generateAndExecuteSQL = schemaTask({
  id: "generate-and-execute-sql",
  description: "Generate and execute SQL",
  schema: z.object({
    model: z.string().default("gpt-4o"),
    input: z.string().describe("The input to generate the SQL from"),
    userId: z.string().describe("The user_id to generate the SQL for"),
  }),
  run: async ({ model, input, userId }) => {
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

      The input will be a user_id and a prompt.

      The output will be a SQL query.

      If the query produced is a mutation, you will need to get approval first from an admin using the queryApproval tool. 
      If the queryApproval tool returns false, you will need to stop and return an error message.
      If the queryApproval tool returns true, you will need to execute the query using the executeSql tool.

      The executeSql tool will return the results of the query. Summarize the results of the query in a human readable format to show the user

      The current time is ${new Date().toISOString()}.

      When creating a todo, you'll need to generate a unique ID for the todo, using the generateId tool.
      For updates, you'll need to use the getUserTodos tool to find the todo first.

      IMPORTANT: Don't ask the user to provide any more information to help you generate the SQL query, do your best to generate the query based on the input alone.
    `;

    const prompt = `
      User ${userId} has the following prompt: ${input}

      Generate a SQL query to execute.
    `;

    const result = streamText({
      model: openai(model),
      system,
      prompt,
      maxSteps: 10,
      tools: {
        queryApproval: {
          description: "Use this tool to get approval for a SQL query from an admin",
          parameters: z.object({
            query: z.string().describe("The SQL query to execute"),
          }),
          execute: async ({ query }) => {
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
        },
        executeSql: {
          description: "Use this tool to execute a SQL query",
          parameters: z.object({
            query: z.string().describe("The SQL query to execute"),
          }),
          execute: async ({ query }) => {
            return await sql.query(query);
          },
        },
        generateId: {
          description: "Use this tool to generate a unique ID for a todo",
          parameters: z.object({
            prefix: z
              .string()
              .describe("The prefix for the ID (defaults to 'todo')")
              .default("todo"),
          }),
          execute: async ({ prefix }) => {
            return `${prefix}_${nanoid(12)}`;
          },
        },
        getUserTodos: {
          description: "Use this tool to get all todos for a user",
          parameters: z.object({
            userId: z.string().describe("The user_id to get todos for"),
          }),
          execute: async ({ userId }) => {
            const result = await sql`SELECT * FROM todos WHERE user_id = ${userId}`;

            return result.rows;
          },
        },
      },
    });

    const stream = await metadata.stream("ai", result.fullStream);

    for await (const chunk of stream) {
      logger.info("chunk received", { chunk, "$style.icon": "tabler-brand-openai" });
    }
  },
});

// Initialize the Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

type SendApprovalMessageParams = {
  query: string;
  userId: string;
  tokenId: string;
  publicAccessToken: string;
  input: string;
};

export async function sendSQLApprovalMessage({
  query,
  userId,
  tokenId,
  publicAccessToken,
  input,
}: SendApprovalMessageParams) {
  const response = await slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `SQL Query Approval Required for user ${userId}`, // Fallback text for notifications
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 SQL Query Approval Required",
          emoji: true,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Requested by:* <@${userId}>`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*User Request:*\n" + input,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Generated Query:*\n```sql\n" + query + "\n```",
        },
      },
      {
        type: "actions",
        block_id: "sql_approval_actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Approve ✅",
              emoji: true,
            },
            style: "primary",
            value: JSON.stringify({
              tokenId,
              publicAccessToken,
              action: "approve",
            }),
            action_id: "sql_approve",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Deny ❌",
              emoji: true,
            },
            style: "danger",
            value: JSON.stringify({
              tokenId,
              publicAccessToken,
              action: "deny",
            }),
            action_id: "sql_deny",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "⚠️ This action cannot be undone",
          },
        ],
      },
    ],
  });

  return response;
}

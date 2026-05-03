/**
 * Schema-only tool definitions — shared between the chat.handover
 * route handler and the trigger.dev agent task.
 *
 * ⚠️ HARD CONSTRAINT — bundle isolation
 *
 * This file is imported by `app/api/chat/route.ts` (the chat.handover
 * POST handler) and runs in the Next.js process. Anything imported
 * here lands in the route-handler bundle.
 *
 * Allowed imports: `ai` (for `tool()`), `zod`, type-only AI SDK
 * imports. Nothing else.
 *
 * DO NOT import from this file:
 *   - `@e2b/code-interpreter`, `puppeteer`, `playwright`, native bindings
 *   - `node:child_process`, heavy filesystem ops
 *   - `@trigger.dev/sdk` runtime (`task`, `schemaTask`,
 *     `chat.stream.writer`, etc. — pulls in the whole task runtime)
 *   - `turndown`, image processing libs, anything that pulls weight
 *
 * Heavy `execute` fns live in `src/trigger/chat-tools.ts` — that file
 * imports these schemas and adds executes on top. The agent task
 * picks up the executes when it runs; the route handler never sees
 * them and never imports their deps.
 *
 * If you need to add a new tool to the chat.agent's schema-only set,
 * declare its description + inputSchema here, then wire its execute
 * fn in `src/trigger/chat-tools.ts`.
 */
import { tool } from "ai";
import type { InferUITools, UIDataTypes, UIMessage } from "ai";
import { z } from "zod";

export const inspectEnvironment = tool({
  description:
    "Inspect the current execution environment. Returns runtime info (Node.js/Bun/Deno version), " +
    "OS details, CPU architecture, memory usage, environment variables, and platform metadata.",
  inputSchema: z.object({}),
  // execute → src/trigger/chat-tools.ts
});

export const webFetch = tool({
  description:
    "Fetch a URL and return the response as text. " +
    "Use this to retrieve web pages, APIs, or any HTTP resource.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  // execute → src/trigger/chat-tools.ts (uses turndown)
});

export const deepResearch = tool({
  description:
    "Research a topic by fetching multiple URLs and synthesizing the results. " +
    "Streams progress updates to the chat as it works.",
  inputSchema: z.object({
    query: z.string().describe("The research query or topic"),
    urls: z.array(z.string().url()).describe("URLs to fetch and analyze"),
  }),
  // execute → src/trigger/chat-tools.ts (subtask via ai.toolExecute)
});

export const posthogQuery = tool({
  description:
    "Query PostHog analytics using HogQL. Use this to answer questions about events, " +
    "pageviews, user activity, feature flag usage, or any product analytics question. " +
    "Write a HogQL query (SQL-like syntax over PostHog events).",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "HogQL query, e.g. SELECT event, count() FROM events WHERE timestamp > now() - interval 1 day GROUP BY event ORDER BY count() DESC LIMIT 10"
      ),
  }),
  // execute → src/trigger/chat-tools.ts (HTTP to PostHog)
});

export const executeCode = tool({
  description:
    "Run code in an isolated E2B sandbox (Python by default; other languages supported by E2B). " +
    "Use for calculations, data analysis, or transforming tool outputs (e.g. PostHog query results). " +
    "The sandbox persists across turns in the same run until the chat idles and suspends.",
  inputSchema: z.object({
    code: z.string().describe("Source code to execute in the sandbox"),
    language: z
      .string()
      .optional()
      .describe("Language id (e.g. python, javascript). Defaults to python."),
  }),
  // execute → src/trigger/chat-tools.ts (E2B sandbox — heavy native dep)
});

export const sendEmail = tool({
  description:
    "Send an email to a recipient. Requires human approval before sending. " +
    "Use when the user asks you to send, draft, or compose an email.",
  inputSchema: z.object({
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
  }),
  needsApproval: true,
  // execute → src/trigger/chat-tools.ts
});

export const askUser = tool({
  description:
    "Ask the user a question when you need clarification or input before proceeding. " +
    "Present 2-4 options for the user to choose from. Use when uncertain about the user's intent.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user"),
    options: z
      .array(
        z.object({
          id: z.string().describe("Unique option identifier"),
          label: z.string().describe("Short option title"),
          description: z.string().optional().describe("Longer explanation"),
        })
      )
      .min(2)
      .max(4),
  }),
  // No execute by design — round-tripped through the frontend's addToolOutput.
});

/**
 * The schema-only tool set passed to `chat.headStart`'s `streamText`
 * call. The agent task imports each schema individually and adds the
 * matching `execute` fn — see `src/trigger/chat-tools.ts`.
 */
export const headStartTools = {
  inspectEnvironment,
  webFetch,
  deepResearch,
  posthogQuery,
  executeCode,
  sendEmail,
  askUser,
};

type ChatToolSet = typeof headStartTools;
export type ChatUiTools = InferUITools<ChatToolSet>;
export type ChatUiMessage = UIMessage<unknown, UIDataTypes, ChatUiTools>;

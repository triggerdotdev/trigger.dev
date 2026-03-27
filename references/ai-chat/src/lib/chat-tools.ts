import { ai, chat } from "@trigger.dev/sdk/ai";
import { schemaTask } from "@trigger.dev/sdk";
import { tool, generateId } from "ai";
import type { InferUITools, UIDataTypes, UIMessage } from "ai";
import { z } from "zod";
import os from "node:os";
import TurndownService from "turndown";
import { codeSandboxRun, runWithCodeSandbox } from "@/lib/code-sandbox";

const turndown = new TurndownService();

// Silence TS errors for Bun/Deno global checks
declare const Bun: unknown;
declare const Deno: unknown;

export const inspectEnvironment = tool({
  description:
    "Inspect the current execution environment. Returns runtime info (Node.js/Bun/Deno version), " +
    "OS details, CPU architecture, memory usage, environment variables, and platform metadata.",
  inputSchema: z.object({}),
  execute: async () => {
    const memUsage = process.memoryUsage();

    return {
      runtime: {
        name: typeof Bun !== "undefined" ? "bun" : typeof Deno !== "undefined" ? "deno" : "node",
        version: process.version,
        versions: {
          v8: process.versions.v8,
          openssl: process.versions.openssl,
          modules: process.versions.modules,
        },
      },
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        type: os.type(),
        hostname: os.hostname(),
        uptime: `${Math.floor(os.uptime())}s`,
      },
      cpus: {
        count: os.cpus().length,
        model: os.cpus()[0]?.model,
      },
      memory: {
        total: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
        free: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
        process: {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        },
      },
      env: {
        NODE_ENV: process.env.NODE_ENV,
        TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        LANG: process.env.LANG,
      },
      process: {
        pid: process.pid,
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv.slice(0, 3),
      },
    };
  },
});

export const webFetch = tool({
  description:
    "Fetch a URL and return the response as text. " +
    "Use this to retrieve web pages, APIs, or any HTTP resource.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    const latency = Number(process.env.WEBFETCH_LATENCY_MS);
    if (latency > 0) {
      await new Promise((r) => setTimeout(r, latency));
    }

    const response = await fetch(url);
    let text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("html")) {
      text = turndown.turndown(text);
    }

    return {
      status: response.status,
      contentType,
      body: text.slice(0, 2000),
      truncated: text.length > 2000,
    };
  },
});

const deepResearchTask = schemaTask({
  id: "deep-research",
  description:
    "Research a topic by fetching multiple URLs and synthesizing the results. " +
    "Streams progress updates to the chat as it works.",
  schema: z.object({
    query: z.string().describe("The research query or topic"),
    urls: z.array(z.string().url()).describe("URLs to fetch and analyze"),
  }),
  run: async ({ query, urls }) => {
    const partId = generateId();
    const results: { url: string; status: number; snippet: string }[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      const { waitUntilComplete } = chat.stream.writer({
        target: "root",
        execute: ({ write }) => {
          write({
            type: "data-research-progress",
            id: partId,
            data: {
              status: "fetching" as const,
              query,
              current: i + 1,
              total: urls.length,
              currentUrl: url,
              completedUrls: results.map((r) => r.url),
            },
          });
        },
      });
      await waitUntilComplete();

      try {
        const response = await fetch(url);
        let text = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("html")) {
          text = turndown.turndown(text);
        }

        results.push({
          url,
          status: response.status,
          snippet: text.slice(0, 500),
        });
      } catch (err) {
        results.push({
          url,
          status: 0,
          snippet: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const { waitUntilComplete: waitForDone } = chat.stream.writer({
      target: "root",
      execute: ({ write }) => {
        write({
          type: "data-research-progress",
          id: partId,
          data: {
            status: "done" as const,
            query,
            current: urls.length,
            total: urls.length,
            completedUrls: results.map((r) => r.url),
          },
        });
      },
    });
    await waitForDone();

    return { query, results };
  },
});

/** Task-backed tool: AI SDK `tool()` for shape/types; `ai.toolExecute` for Trigger subtask + metadata. */
export const deepResearch = tool({
  description: deepResearchTask.description ?? "",
  inputSchema: deepResearchTask.schema!,
  execute: ai.toolExecute(deepResearchTask),
});

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";

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
  execute: async ({ query }) => {
    if (!POSTHOG_API_KEY || !POSTHOG_PROJECT_ID) {
      return { error: "PostHog not configured. Set POSTHOG_API_KEY and POSTHOG_PROJECT_ID." };
    }
    const response = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${POSTHOG_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { error: `PostHog API error ${response.status}: ${text.slice(0, 500)}` };
    }

    const data = await response.json();
    return {
      columns: data.columns,
      results: data.results?.slice(0, 50),
      rowCount: data.results?.length ?? 0,
    };
  },
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
  execute: async function executeCodeExecute({ code, language }) {
    const runId = codeSandboxRun.runId;
    if (!runId?.trim()) {
      return {
        error:
          "Code sandbox run id is not set yet (call from the chat task after onTurnStart), or this tool is not wired to that task.",
      };
    }

    const out = await runWithCodeSandbox(runId, async function runInSandbox(sandbox) {
      const execution = await sandbox.runCode(code, {
        ...(language?.trim() ? { language: language.trim() } : {}),
        timeoutMs: 60_000,
      });

      if (execution.error) {
        return {
          error: `${execution.error.name}: ${execution.error.value}`,
          traceback: execution.error.traceback,
          stdout: execution.logs.stdout.join("\n"),
          stderr: execution.logs.stderr.join("\n"),
        };
      }

      const mainText = execution.text;
      const resultSnippets = execution.results
        .map(function mapResult(r) {
          return r.text ?? r.markdown ?? r.json;
        })
        .filter(Boolean)
        .slice(0, 5);

      return {
        text: mainText,
        results: resultSnippets,
        stdout: execution.logs.stdout.join("\n"),
        stderr: execution.logs.stderr.join("\n"),
      };
    });

    return out;
  },
});

/** Tool set passed to `streamText` for the main `chat.task` run (includes PostHog). */
export const chatTools = {
  inspectEnvironment,
  webFetch,
  deepResearch,
  posthogQuery,
  executeCode,
};

type ChatToolSet = typeof chatTools;

export type ChatUiTools = InferUITools<ChatToolSet>;
export type ChatUiMessage = UIMessage<unknown, UIDataTypes, ChatUiTools>;

/**
 * Tool executes for the trigger.dev agent task.
 *
 * These tools wrap the schema-only definitions from
 * `@/lib/chat-tools-schemas` with their heavy `execute` fns. This
 * file is ONLY imported from inside the trigger task module
 * (`src/trigger/chat.ts`); it must NOT be imported from anything that
 * runs in the Next.js process (route handlers, components, server
 * actions, etc.).
 *
 * See `src/lib/chat-tools-schemas.ts` for why this split matters —
 * the bundle-isolation constraint is what makes `chat.handover`'s
 * cold-start win possible.
 */
import { ai, chat } from "@trigger.dev/sdk/ai";
import { schemaTask } from "@trigger.dev/sdk";
import { tool, generateId } from "ai";
import { z } from "zod";
import os from "node:os";
import TurndownService from "turndown";
import { codeSandboxRun, runWithCodeSandbox } from "@/lib/code-sandbox";
import {
  inspectEnvironment as inspectEnvironmentSchema,
  webFetch as webFetchSchema,
  deepResearch as deepResearchSchema,
  posthogQuery as posthogQuerySchema,
  executeCode as executeCodeSchema,
  sendEmail as sendEmailSchema,
  askUser as askUserSchema,
  getCurrentTime as getCurrentTimeSchema,
  searchHackerNews as searchHackerNewsSchema,
  createGithubIssue as createGithubIssueSchema,
} from "@/lib/chat-tools-schemas";

const turndown = new TurndownService();

declare const Bun: unknown;
declare const Deno: unknown;

export const inspectEnvironment = tool({
  ...inspectEnvironmentSchema,
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
  ...webFetchSchema,
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
  ...deepResearchSchema,
  execute: ai.toolExecute(deepResearchTask),
});

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";

export const posthogQuery = tool({
  ...posthogQuerySchema,
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
  ...executeCodeSchema,
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

export const sendEmail = tool({
  ...sendEmailSchema,
  execute: async ({ to, subject, body }) => {
    // Simulated — in a real app this would call an email API
    return { sent: true, to, subject, preview: body.slice(0, 100) };
  },
});

// askUser has no execute by design — round-tripped via addToolOutput.
export const askUser = askUserSchema;

export const getCurrentTime = tool({
  ...getCurrentTimeSchema,
  execute: async () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      iso: now.toISOString(),
      unixMs: now.getTime(),
      timezone: tz,
      local: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }),
      utc: now.toUTCString(),
      dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
    };
  },
});

export const searchHackerNews = tool({
  ...searchHackerNewsSchema,
  execute: async ({ query, limit = 5 }) => {
    if (query) {
      // Algolia HN search — story type only, sorted by points
      const url = new URL("https://hn.algolia.com/api/v1/search");
      url.searchParams.set("query", query);
      url.searchParams.set("tags", "story");
      url.searchParams.set("hitsPerPage", String(limit));
      const res = await fetch(url);
      if (!res.ok) return { error: `Algolia error ${res.status}` };
      const json = (await res.json()) as {
        hits: Array<{
          objectID: string;
          title?: string;
          url?: string;
          author: string;
          points?: number;
          num_comments?: number;
          created_at: string;
        }>;
      };
      return {
        query,
        results: json.hits.map((h) => ({
          title: h.title ?? "(no title)",
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          author: h.author,
          points: h.points ?? 0,
          comments: h.num_comments ?? 0,
          createdAt: h.created_at,
        })),
      };
    }
    // Top stories — first /topstories.json then per-item lookups
    const idsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
    if (!idsRes.ok) return { error: `HN error ${idsRes.status}` };
    const ids = (await idsRes.json()) as number[];
    const top = ids.slice(0, limit);
    const items = await Promise.all(
      top.map(async (id) => {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!r.ok) return null;
        const it = (await r.json()) as {
          id: number;
          title?: string;
          url?: string;
          by: string;
          score?: number;
          descendants?: number;
          time: number;
        };
        return {
          title: it.title ?? "(no title)",
          url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
          author: it.by,
          points: it.score ?? 0,
          comments: it.descendants ?? 0,
          createdAt: new Date(it.time * 1000).toISOString(),
        };
      })
    );
    return { topStories: items.filter((x) => x !== null) };
  },
});

export const createGithubIssue = tool({
  ...createGithubIssueSchema,
  execute: async ({ repo, title, body, labels }) => {
    // Simulated — in a real app this would call the GitHub API
    const issueNumber = Math.floor(Math.random() * 9000) + 1000;
    return {
      created: true,
      repo,
      issueNumber,
      url: `https://github.com/${repo}/issues/${issueNumber}`,
      title,
      labels: labels ?? [],
      preview: body.slice(0, 120),
    };
  },
});

/** Tool set passed to `streamText` for the main `chat.agent` run. */
export const chatTools = {
  inspectEnvironment,
  webFetch,
  deepResearch,
  posthogQuery,
  executeCode,
  sendEmail,
  askUser,
  getCurrentTime,
  searchHackerNews,
  createGithubIssue,
};

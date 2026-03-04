import { chat } from "@trigger.dev/sdk/ai";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import os from "node:os";

const inspectEnvironment = tool({
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

// Silence TS errors for Bun/Deno global checks
declare const Bun: unknown;
declare const Deno: unknown;

export const aiChat = chat.task({
  id: "ai-chat",
  run: async ({ messages, stopSignal }) => {
    return streamText({
      model: openai("gpt-4o-mini"),
      system: "You are a helpful assistant. Be concise and friendly.",
      messages: await convertToModelMessages(messages),
      tools: { inspectEnvironment },
      stopWhen: stepCountIs(10),
      abortSignal: stopSignal,
    });
  },
});

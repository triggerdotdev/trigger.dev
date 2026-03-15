import { z } from "zod";
import { x, type Result } from "tinyexec";
import stripAnsi from "strip-ansi";
import { toolsMetadata } from "../config.js";
import { respondWithError, toolHandler } from "../utils.js";
import { resolveCLIExec } from "./deploys.js";

type DevState = "stopped" | "starting" | "ready" | "error";

// State for the running dev server process
let devProcess: Result | null = null;
let devState: DevState = "stopped";
let devLogs: string[] = [];
let devCwd: string | undefined;
const MAX_LOG_LINES = 200;

function getDevState(): DevState {
  return devState;
}

function pushLog(line: string) {
  devLogs.push(line);
  if (devLogs.length > MAX_LOG_LINES) {
    devLogs = devLogs.slice(-MAX_LOG_LINES);
  }
}

const StartDevServerInput = {
  configPath: z
    .string()
    .describe(
      "The path to the trigger.config.ts file or project directory. Only needed when the trigger.config.ts file is not at the root dir."
    )
    .optional(),
};

export const startDevServerTool = {
  name: toolsMetadata.start_dev_server.name,
  title: toolsMetadata.start_dev_server.title,
  description: toolsMetadata.start_dev_server.description,
  inputSchema: StartDevServerInput,
  handler: toolHandler(StartDevServerInput, async (input, { ctx }) => {
    ctx.logger?.log("calling start_dev_server", { input });

    if (devProcess && devState !== "stopped") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Dev server is already ${devState}. Use \`dev_server_status\` to see output or \`stop_dev_server\` to stop it.`,
          },
        ],
      };
    }

    const cwd = await ctx.getProjectDir({ cwd: input.configPath });

    if (!cwd.ok) {
      return respondWithError(cwd.error);
    }

    const auth = await ctx.getAuth();

    const args = ["dev", "--api-url", auth.auth.apiUrl, "--skip-mcp-install"];

    if (ctx.options.profile) {
      args.push("--profile", ctx.options.profile);
    }

    const [nodePath, cliPath] = await resolveCLIExec(ctx, cwd.cwd);

    ctx.logger?.log("start_dev_server args", { nodePath, cliPath, args, cwd: cwd.cwd });

    // Reset state
    devState = "starting";
    devLogs = [];
    devCwd = cwd.cwd;

    devProcess = x(nodePath, [cliPath, ...args], {
      nodeOptions: {
        cwd: cwd.cwd,
        env: {
          TRIGGER_MCP_SERVER: "1",
        },
      },
    });

    // Stream output in the background
    const readOutput = async () => {
      try {
        for await (const line of devProcess!) {
          const clean = stripAnsi(line);
          pushLog(clean);

          if (clean.includes("Local worker ready")) {
            devState = "ready";
          }

          if (clean.includes("Build failed")) {
            devState = "error";
          }
        }
      } catch {
        // Process ended
      }

      // When the process exits
      const exitCode = devProcess?.exitCode;
      if (devState !== "error") {
        devState = "stopped";
      }
      pushLog(`[process exited with code ${exitCode ?? "unknown"}]`);
      devProcess = null;
    };

    // Don't await — let it run in the background
    readOutput();

    // Wait up to 30s for "ready" or "error"
    const startTime = Date.now();
    const TIMEOUT_MS = 30_000;

    while (Date.now() - startTime < TIMEOUT_MS) {
      const state = getDevState();
      if (state === "ready" || state === "error" || state === "stopped") {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const recentLogs = devLogs.slice(-30).join("\n");
    const finalState = getDevState();

    if (finalState === "ready") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Dev server is ready.\n\n\`\`\`\n${recentLogs}\n\`\`\``,
          },
        ],
      };
    }

    if (finalState === "error") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Dev server started but has build errors:\n\n\`\`\`\n${recentLogs}\n\`\`\``,
          },
        ],
      };
    }

    if (finalState === "starting") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Dev server is still starting (timed out after 30s). Use \`dev_server_status\` to check progress.\n\n\`\`\`\n${recentLogs}\n\`\`\``,
          },
        ],
      };
    }

    return respondWithError(`Dev server stopped unexpectedly:\n${recentLogs}`);
  }),
};

export const stopDevServerTool = {
  name: toolsMetadata.stop_dev_server.name,
  title: toolsMetadata.stop_dev_server.title,
  description: toolsMetadata.stop_dev_server.description,
  inputSchema: {},
  handler: toolHandler({}, async (_input, { ctx }) => {
    ctx.logger?.log("calling stop_dev_server");

    if (!devProcess || devState === "stopped") {
      return {
        content: [{ type: "text" as const, text: "Dev server is not running." }],
      };
    }

    devProcess.kill();
    devState = "stopped";
    devProcess = null;

    return {
      content: [{ type: "text" as const, text: "Dev server stopped." }],
    };
  }),
};

export const devServerStatusTool = {
  name: toolsMetadata.dev_server_status.name,
  title: toolsMetadata.dev_server_status.title,
  description: toolsMetadata.dev_server_status.description,
  inputSchema: {
    lines: z
      .number()
      .int()
      .default(50)
      .describe("Number of recent log lines to return. Defaults to 50."),
  },
  handler: toolHandler(
    {
      lines: z.number().int().default(50),
    },
    async (input, { ctx }) => {
      ctx.logger?.log("calling dev_server_status");

      const recentLogs = devLogs.slice(-input.lines).join("\n");

      const content = [
        `## Dev Server Status: ${devState}`,
        "",
      ];

      if (devCwd) {
        content.push(`**Directory:** ${devCwd}`);
      }

      content.push(`**Log buffer:** ${devLogs.length} lines`);
      content.push("");

      if (recentLogs) {
        content.push("```");
        content.push(recentLogs);
        content.push("```");
      } else {
        content.push("_No output yet_");
      }

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
      };
    }
  ),
};

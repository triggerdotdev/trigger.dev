import { query, type SDKMessage } from "@anthropic-ai/claude-code";
import { Context, logger, metadata, schemaTask, wait } from "@trigger.dev/sdk";
import { readFile } from "fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "path";
import { z } from "zod";

type CHUNK = { iteration: number; message: SDKMessage };

export type STREAMS = {
  claude: CHUNK;
};

export const codeTask = schemaTask({
  id: "claude-code",
  schema: z.object({
    prompt: z.string(),
    maxTurns: z.number().default(3),
    maxIterations: z.number().default(10),
  }),
  run: async ({ prompt, maxTurns, maxIterations }, { signal, ctx }) => {
    const abortController = new AbortController();

    signal.addEventListener("abort", () => {
      abortController.abort();
    });

    const pathToClaudeCodeExecutable = getPathToClaudeCodeExecutable(ctx);

    const settings = await readFile(join(process.cwd(), ".claude-settings.json"));

    const settingsJson = JSON.parse(settings.toString());

    logger.log("settings", { settingsJson });

    // Create a temporary directory for claude-code to work in
    const tempDir = tmpdir();

    logger.log("Starting claude code loop", { pathToClaudeCodeExecutable, cwd: tempDir });

    let $currentPrompt = prompt;

    let sessionId: string | undefined;

    const { stream, write } = createStream<CHUNK>();

    await metadata.stream("claude", stream);

    for (let i = 0; i < maxIterations; i++) {
      logger.info("Starting iteration", { iteration: i, prompt: $currentPrompt, sessionId });

      const messages: SDKMessage[] = [];

      const result = query({
        prompt: $currentPrompt,
        abortController,
        options: {
          resume: sessionId,
          cwd: tempDir,
          maxTurns,
          pathToClaudeCodeExecutable,
          permissionMode: "bypassPermissions",
          allowedTools: [
            "Task",
            "Bash",
            "Glob",
            "Grep",
            "LS",
            "exit_plan_mode",
            "Read",
            "Edit",
            "MultiEdit",
            "Write",
            "NotebookRead",
            "NotebookEdit",
            "WebFetch",
            "TodoRead",
            "TodoWrite",
            "WebSearch",
          ],
        },
      });

      for await (const message of result) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }

        messages.push(message);

        write({ iteration: i, message });

        logger.log("message", { message, iteration: i });
      }

      await saveMessages(messages);

      const continueToken = await wait.createToken({ timeout: "7d" });

      const nextPrompt = await wait.forToken<{ prompt: string }>(continueToken);

      if (nextPrompt.ok) {
        logger.info("Continuing with prompt", { prompt: nextPrompt.output.prompt });

        $currentPrompt = nextPrompt.output.prompt;
      } else {
        logger.info("No more prompts", { iteration: i });

        break; // break out of the loop
      }
    }
  },
});

export function createStream<T>(): { stream: ReadableStream<T>; write: (data: T) => void } {
  let controller!: ReadableStreamDefaultController<T>;

  const stream = new ReadableStream({
    start(controllerArg) {
      controller = controllerArg;
    },
  });

  function safeEnqueue(data: T) {
    try {
      controller.enqueue(data);
    } catch (error) {
      // suppress errors when the stream has been closed
    }
  }

  return {
    stream,
    write: safeEnqueue,
  };
}

async function saveMessages(messages: SDKMessage[]) {
  logger.log("Saving messages", { messages });
  // TODO: save messages to a database
}

function getPathToClaudeCodeExecutable(ctx: Context) {
  return ctx.environment.type === "DEVELOPMENT"
    ? resolve(
        join(
          process.cwd(),
          "..",
          "..",
          "..",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js"
        )
      )
    : join(process.cwd(), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
}

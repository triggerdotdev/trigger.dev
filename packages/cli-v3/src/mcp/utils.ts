import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import z from "zod";
import { ToolMeta } from "./types.js";
import { loadConfig } from "../config.js";

export function respondWithError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: enumerateError(error) }),
      },
    ],
  };
}

function enumerateError(error: unknown) {
  if (!error) {
    return error;
  }

  if (typeof error !== "object") {
    return error;
  }

  const newError: Record<string, unknown> = {};

  const errorProps = ["name", "message"] as const;

  for (const prop of errorProps) {
    if (prop in error) {
      newError[prop] = (error as Record<string, unknown>)[prop];
    }
  }

  return newError;
}

export type ToolHandlerMeta = ToolMeta & {
  createProgressTracker: (total: number) => ProgressTracker;
};

export function toolHandler<TInputShape extends z.ZodRawShape>(
  shape: TInputShape,
  handler: (
    input: z.output<z.ZodObject<TInputShape>>,
    meta: ToolHandlerMeta
  ) => Promise<CallToolResult>
) {
  return async (input: unknown, extra: ToolMeta) => {
    const parsedInput = z.object(shape).safeParse(input);

    if (!parsedInput.success) {
      return respondWithError(parsedInput.error);
    }

    function createProgressTracker(total: number) {
      return new ProgressTracker(total, extra.sendNotification, extra._meta?.progressToken);
    }

    return handler(parsedInput.data, { ...extra, createProgressTracker });
  };
}

class ProgressTracker {
  private progress: number = 0;
  private progressToken: string | number | undefined;
  private total: number;
  private message: string;
  private sendNotification: (notification: ServerNotification) => Promise<void>;

  constructor(
    total: number,
    sendNotification: (notification: ServerNotification) => Promise<void>,
    progressToken?: string | number
  ) {
    this.message = "";
    this.progressToken = progressToken;
    this.progress = 0;
    this.total = total;
    this.sendNotification = sendNotification;
  }

  async updateProgress(progress: number, message?: string) {
    this.progress = progress;

    if (message) {
      this.message = message;
    }

    await this.#sendNotification(progress, this.message);
  }

  async incrementProgress(increment: number, message?: string) {
    this.progress += increment;

    // make sure the progress is never greater than the total
    this.progress = Math.min(this.progress, this.total);

    if (message) {
      this.message = message;
    }

    await this.#sendNotification(this.progress, this.message);
  }

  async complete(message?: string) {
    this.progress = this.total;
    if (message) {
      this.message = message;
    }
    await this.#sendNotification(this.progress, this.message);
  }

  getProgress() {
    return this.progress;
  }

  async #sendNotification(progress: number, message: string) {
    if (!this.progressToken) {
      return;
    }

    await this.sendNotification({
      method: "notifications/progress",
      params: {
        progress,
        total: this.total,
        message: this.message,
        progressToken: this.progressToken,
      },
    });
  }
}

/**
 * Stdio-based IPC connection for Python workers.
 *
 * Communicates with Python processes via line-delimited JSON over stdio.
 * Compatible with Python's StdioIpcConnection implementation.
 */

import { ChildProcess } from "child_process";
import readline from "readline";
import { z } from "zod";
import { EventEmitter } from "events";
import { logger } from "../utilities/logger.js";

// Message schemas matching Python Pydantic schemas
const TaskRunCompletedSchema = z.object({
  type: z.literal("TASK_RUN_COMPLETED"),
  version: z.literal("v1"),
  completion: z.object({
    ok: z.literal(true),
    id: z.string(),
    output: z.string(),
    outputType: z.string(),
    usage: z
      .object({
        durationMs: z.number().optional(),
      })
      .optional(),
  }),
});

const TaskRunFailedSchema = z.object({
  type: z.literal("TASK_RUN_FAILED_TO_RUN"),
  version: z.literal("v1"),
  completion: z.object({
    ok: z.literal(false),
    id: z.string(),
    error: z.object({
      type: z.string(),
      message: z.string(),
      stackTrace: z.string().optional(),
    }),
    usage: z
      .object({
        durationMs: z.number().optional(),
      })
      .optional(),
  }),
});

const TaskHeartbeatSchema = z.object({
  type: z.literal("TASK_HEARTBEAT"),
  version: z.literal("v1"),
  id: z.string(),
});

const IndexCompleteSchema = z.object({
  type: z.literal("INDEX_COMPLETE"),
  version: z.literal("v1"),
  payload: z.object({
    manifest: z.record(z.any()),
    importErrors: z.array(z.any()),
  }),
});

const WorkerMessageSchema = z.discriminatedUnion("type", [
  TaskRunCompletedSchema,
  TaskRunFailedSchema,
  TaskHeartbeatSchema,
  IndexCompleteSchema,
]);

type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export interface StdioIpcOptions {
  process: ChildProcess;
  handleStderr?: boolean;
}

export class StdioIpcConnection extends EventEmitter {
  private process: ChildProcess;
  private stdoutReader: readline.Interface | undefined;
  private stderrReader: readline.Interface | undefined;
  private closed = false;

  constructor(options: StdioIpcOptions) {
    super();
    this.process = options.process;

    // Set up stdout reader for IPC messages
    if (this.process.stdout) {
      this.stdoutReader = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.stdoutReader.on("line", (line) => this.handleStdoutLine(line));
    }

    // Set up stderr reader for logs (optional)
    if (options.handleStderr && this.process.stderr) {
      this.stderrReader = readline.createInterface({
        input: this.process.stderr,
        crlfDelay: Infinity,
      });

      this.stderrReader.on("line", (line) => this.handleStderrLine(line));
    }

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.process.on("error", (error) => {
      this.emit("error", error);
    });
  }

  private handleStdoutLine(line: string) {
    if (!line.trim()) return;

    try {
      const data = JSON.parse(line);
      const message = WorkerMessageSchema.parse(data);

      logger.debug("Received message from Python worker", {
        type: message.type,
        message,
      });

      this.emit("message", message);
      this.emit(message.type, message);
    } catch (error) {
      logger.error("Failed to parse Python worker message", {
        line,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit("parseError", error);
    }
  }

  private handleStderrLine(line: string) {
    if (!line.trim()) return;

    try {
      // Try to parse as structured log
      const logData = JSON.parse(line);
      this.emit("log", logData);
    } catch {
      // Plain text log
      this.emit("log", { message: line, level: "INFO" });
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.closed) return;

    logger.debug("Python worker process exited", { code, signal });

    this.close();
    this.emit("exit", code, signal);
  }

  send(message: Record<string, any>) {
    if (this.closed) {
      throw new Error("Cannot send message: IPC connection closed");
    }

    if (!this.process.stdin) {
      throw new Error("Process stdin not available");
    }

    try {
      const json = JSON.stringify(message);
      this.process.stdin.write(json + "\n");

      logger.debug("Sent message to Python worker", {
        type: message.type,
        message,
      });
    } catch (error) {
      logger.error("Failed to send message to Python worker", { error });
      throw error;
    }
  }

  close() {
    if (this.closed) return;

    this.closed = true;

    this.stdoutReader?.close();
    this.stderrReader?.close();

    if (this.process.stdin) {
      this.process.stdin.end();
    }

    this.removeAllListeners();
  }

  get isClosed() {
    return this.closed;
  }
}

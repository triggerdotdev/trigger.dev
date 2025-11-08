/**
 * Python worker process management.
 *
 * Spawns Python workers and manages their lifecycle.
 */

import { spawn, ChildProcess } from "child_process";
import { BuildRuntime } from "@trigger.dev/core/v3";
import { StdioIpcConnection } from "./stdioIpc.js";
import { logger } from "../utilities/logger.js";
import { execPathForRuntime } from "@trigger.dev/core/v3/build";

export interface PythonProcessOptions {
  workerScript: string;
  cwd?: string;
  env?: Record<string, string>;
  runtime?: BuildRuntime;
}

export class PythonProcess {
  private process: ChildProcess | undefined;
  private ipc: StdioIpcConnection | undefined;

  constructor(private options: PythonProcessOptions) {}

  async start(): Promise<StdioIpcConnection> {
    const pythonBinary = execPathForRuntime(this.options.runtime ?? "python");

    logger.debug("Starting Python worker process", {
      binary: pythonBinary,
      script: this.options.workerScript,
      cwd: this.options.cwd,
    });

    this.process = spawn(
      pythonBinary,
      [
        "-u", // CRITICAL: Unbuffered output for line-delimited JSON IPC
        this.options.workerScript,
      ],
      {
        cwd: this.options.cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...this.options.env,
          // Ensure unbuffered output
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.ipc = new StdioIpcConnection({
      process: this.process,
      handleStderr: true,
    });

    // Forward logs
    this.ipc.on("log", (logData) => {
      logger.debug("Python worker log", logData);
    });

    return this.ipc;
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn("Python worker did not exit gracefully, forcing kill");
        this.process?.kill("SIGKILL");
        resolve();
      }, 5000);

      this.process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process.kill(signal);
    });
  }

  async cleanup(): Promise<void> {
    this.ipc?.close();
    await this.kill();
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }
}

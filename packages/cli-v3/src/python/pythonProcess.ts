/**
 * Python worker process management.
 *
 * Spawns Python workers and manages their lifecycle using gRPC.
 */

import { spawn, ChildProcess } from "child_process";
import { BuildRuntime } from "@trigger.dev/core/v3";
import { GrpcWorkerServer } from "../ipc/grpcServer.js";
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
  private grpcServer: GrpcWorkerServer | undefined;

  constructor(private options: PythonProcessOptions) {}

  async start(): Promise<GrpcWorkerServer> {
    const pythonBinary = execPathForRuntime(this.options.runtime ?? "python");

    // Start gRPC server
    this.grpcServer = new GrpcWorkerServer({
      transport: "tcp", // Use TCP for dev mode (easier debugging)
      tcpPort: 0, // Random available port
    });

    const grpcAddress = await this.grpcServer.start();
    logger.debug("Started gRPC server for Python worker", { address: grpcAddress });

    logger.debug("Starting Python worker process", {
      binary: pythonBinary,
      script: this.options.workerScript,
      cwd: this.options.cwd,
      grpcAddress,
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
          PYTHONUNBUFFERED: "1",
          TRIGGER_GRPC_ADDRESS: grpcAddress,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Handle spawn errors (e.g., Python binary not found, permission denied)
    this.process.on("error", (error) => {
      logger.error("Failed to spawn Python worker process", {
        error: error.message,
        binary: pythonBinary,
        script: this.options.workerScript,
      });
      // Common issues and helpful messages
      if (error.message.includes("ENOENT")) {
        logger.error(
          `Python binary not found at '${pythonBinary}'. ` +
          `Please ensure Python is installed and in your PATH, or set PYTHON_PATH environment variable.`
        );
      } else if (error.message.includes("EACCES")) {
        logger.error(
          `Permission denied executing '${pythonBinary}'. ` +
          `Please check file permissions.`
        );
      }
    });

    // Forward stderr logs from Python process
    this.process.stderr?.on("data", (data) => {
      const output = data.toString().trim();
      if (!output) return;

      // Try to parse as structured JSON log
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const logEntry = JSON.parse(line);
          if (logEntry.level && logEntry.message) {
            // Handle structured log with appropriate level
            const level = logEntry.level.toLowerCase();
            const logData = {
              message: logEntry.message,
              ...(logEntry.logger && { logger: logEntry.logger }),
              ...(logEntry.exception && { exception: logEntry.exception }),
            };

            switch (level) {
              case "debug":
                logger.debug("Python worker", logData);
                break;
              case "info":
                logger.info("Python worker", logData);
                break;
              case "warn":
              case "warning":
                logger.warn("Python worker", logData);
                break;
              case "error":
              case "critical":
                logger.error("Python worker", logData);
                if (logEntry.exception) {
                  console.error(`[Python] ${logEntry.message}\n${logEntry.exception}`);
                }
                break;
              default:
                logger.info("Python worker", logData);
            }
          } else {
            // JSON but not structured log format
            logger.info("Python worker", { output: line });
          }
        } catch {
          // Not JSON, treat as regular stderr
          logger.error("Python worker stderr", { output: line });
          console.error(`[Python stderr] ${line}`);
        }
      }
    });

    // Forward stdout logs from Python process
    this.process.stdout?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        logger.info("Python worker stdout", { output });
        console.log(`[Python stdout] ${output}`);
      }
    });

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      if (code === 0) {
        logger.debug("Python worker exited", { code, signal });
      } else {
        logger.error("Python worker exited", { code, signal });
      }
    });

    return this.grpcServer;
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process) return;

    const process = this.process;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn("Python worker did not exit gracefully, forcing kill");
        process.kill("SIGKILL");
        resolve();
      }, 5000);

      process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      process.kill(signal);
    });
  }

  async cleanup(): Promise<void> {
    await this.kill();
    if (this.grpcServer) {
      await this.grpcServer.stop();
    }
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }
}

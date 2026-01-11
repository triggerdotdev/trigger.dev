import { ChildProcess, spawn } from "child_process";
import path from "path";
import fs from "fs";
import type { ConsumerConfig, ProfilingConfig } from "./config";

interface ConsumerMetrics {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  eventLoopUtilization: number;
}

interface BatchFlushedEvent {
  flushId: string;
  taskRunInserts: any[];
  payloadInserts: any[];
}

export class ConsumerProcessManager {
  private process: ChildProcess | null = null;
  private ready = false;
  private onMetrics?: (metrics: ConsumerMetrics) => void;
  private onBatchFlushed?: (event: BatchFlushedEvent) => void;
  private onError?: (error: string) => void;

  constructor(
    private readonly config: ConsumerConfig,
    private readonly profiling: ProfilingConfig
  ) {}

  async start(): Promise<void> {
    const args = this.profiling.enabled && this.profiling.tool !== "none"
      ? this.buildClinicArgs()
      : this.buildDirectArgs();

    console.log("Starting consumer process:", args.join(" "));

    const isProfiling = this.profiling.enabled && this.profiling.tool !== "none";

    this.process = spawn(args[0], args.slice(1), {
      cwd: path.join(__dirname, "../.."), // Run from webapp directory
      env: {
        ...process.env,
        CONSUMER_CONFIG: JSON.stringify(this.config),
      },
      stdio: isProfiling
        ? ["ignore", "pipe", "pipe", "ipc"]  // Capture stdout/stderr when profiling to detect readiness
        : ["ignore", "inherit", "inherit", "ipc"],
    });

    // When profiling, watch stdout for readiness message since IPC might not work
    if (isProfiling && this.process.stdout) {
      this.process.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        process.stdout.write(output); // Still show output
        if (output.includes("Consumer process ready")) {
          this.ready = true;
          console.log("Consumer process is ready (detected from stdout)");
        }
      });
    }

    if (isProfiling && this.process.stderr) {
      this.process.stderr.on("data", (data: Buffer) => {
        process.stderr.write(data.toString()); // Show stderr
      });
    }

    // Handle messages from child process (works when IPC is available)
    this.process.on("message", (msg: any) => {
      if (msg.type === "ready") {
        this.ready = true;
        console.log("Consumer process is ready");
      } else if (msg.type === "metrics" && this.onMetrics) {
        this.onMetrics(msg.data);
      } else if (msg.type === "batchFlushed" && this.onBatchFlushed) {
        this.onBatchFlushed(msg.data);
      } else if (msg.type === "error" && this.onError) {
        this.onError(msg.error);
      }
    });

    this.process.on("error", (error) => {
      console.error("Consumer process error:", error);
      if (this.onError) {
        this.onError(error.message);
      }
    });

    this.process.on("exit", (code, signal) => {
      console.log(`Consumer process exited with code ${code}, signal ${signal}`);
    });

    // Wait for ready signal
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    console.log("Stopping consumer process");

    const isProfiling = this.profiling.enabled && this.profiling.tool !== "none";

    if (isProfiling) {
      // When profiling, IPC doesn't work - use a shutdown signal file instead
      const outputDir = this.config.outputDir || "/tmp";
      const shutdownFilePath = path.join(outputDir, ".shutdown-signal");
      console.log("Creating shutdown signal file for consumer (profiling mode)");

      // Ensure directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(shutdownFilePath, "shutdown");
    } else {
      // For non-profiling runs, use IPC message
      try {
        this.process.send({ type: "shutdown" });
      } catch (error) {
        console.warn("Could not send shutdown message, process may have already exited");
      }
    }

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      // With shutdown signal file, consumer-runner should exit within a few seconds
      // With --collect-only, Clinic.js then quickly packages the data and exits
      const timeoutMs = isProfiling ? 15000 : 30000;

      const timeout = setTimeout(() => {
        console.warn(`Consumer process did not exit after ${timeoutMs}ms, killing`);
        this.process?.kill("SIGKILL");
        resolve();
      }, timeoutMs);

      this.process?.on("exit", (code, signal) => {
        clearTimeout(timeout);
        console.log(`Consumer process exited with code ${code}, signal ${signal}`);
        resolve();
      });
    });

    this.process = null;
    this.ready = false;
  }

  setOnMetrics(callback: (metrics: ConsumerMetrics) => void): void {
    this.onMetrics = callback;
  }

  setOnBatchFlushed(callback: (event: BatchFlushedEvent) => void): void {
    this.onBatchFlushed = callback;
  }

  setOnError(callback: (error: string) => void): void {
    this.onError = callback;
  }

  isReady(): boolean {
    return this.ready;
  }

  private buildDirectArgs(): string[] {
    const runnerPath = path.join(__dirname, "consumer-runner.ts");
    return ["tsx", runnerPath];
  }

  private buildClinicArgs(): string[] {
    const tool = this.profiling.tool === "both" ? "doctor" : this.profiling.tool;
    const runnerPath = path.join(__dirname, "consumer-runner.ts");

    // Use clinic from node_modules/.bin directly (more reliable than pnpm exec)
    const clinicPath = path.join(__dirname, "../../node_modules/.bin/clinic");

    // Point --dest to the output directory itself
    // Clinic.js will create PID.clinic-flame inside this directory
    const destPath = path.resolve(this.profiling.outputDir);

    // Clinic.js requires node, so use node with tsx/register loader
    const args = [
      clinicPath,
      tool,
      "--collect-only", // Only collect data, don't generate visualization immediately
      "--open=false", // Don't try to open in browser
      "--dest",
      destPath,
      "--",
      "node",
      "--import",
      "tsx",
      runnerPath,
    ];

    console.log(`Clinic.js will save profiling data to: ${destPath}`);

    return args;
  }

  private async waitForReady(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (!this.ready) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Consumer process did not become ready within timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export class ProducerProcessManager {
  private process: ChildProcess | null = null;
  private ready = false;
  private onMetrics?: (metrics: any) => void;
  private onError?: (error: string) => void;

  constructor(private readonly config: any) {}

  async start(): Promise<void> {
    const runnerPath = path.join(__dirname, "producer-runner.ts");
    const args = ["tsx", runnerPath];

    console.log("Starting producer process:", args.join(" "));

    this.process = spawn(args[0], args.slice(1), {
      env: {
        ...process.env,
        PRODUCER_CONFIG: JSON.stringify(this.config),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    this.process.on("message", (msg: any) => {
      if (msg.type === "ready") {
        this.ready = true;
        console.log("Producer process is ready");
      } else if (msg.type === "metrics" && this.onMetrics) {
        this.onMetrics(msg.data);
      } else if (msg.type === "started") {
        console.log("Producer has started production");
      } else if (msg.type === "stopped") {
        console.log("Producer has stopped production");
      } else if (msg.type === "error" && this.onError) {
        this.onError(msg.error);
      }
    });

    this.process.on("error", (error) => {
      console.error("Producer process error:", error);
      if (this.onError) {
        this.onError(error.message);
      }
    });

    this.process.on("exit", (code, signal) => {
      console.log(`Producer process exited with code ${code}, signal ${signal}`);
    });

    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    console.log("Stopping producer process");
    this.process.send({ type: "shutdown" });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("Producer process did not exit gracefully, killing");
        this.process?.kill("SIGKILL");
        resolve();
      }, 10000);

      this.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.ready = false;
  }

  send(message: any): void {
    if (!this.process) {
      throw new Error("Producer process not started");
    }
    this.process.send(message);
  }

  setOnMetrics(callback: (metrics: any) => void): void {
    this.onMetrics = callback;
  }

  setOnError(callback: (error: string) => void): void {
    this.onError = callback;
  }

  isReady(): boolean {
    return this.ready;
  }

  private async waitForReady(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (!this.ready) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Producer process did not become ready within timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

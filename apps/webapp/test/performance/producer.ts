import { PrismaClient } from "@trigger.dev/database";
import { TaskRunDataGenerator } from "./data-generator";
import type { ProducerMetrics } from "./config";

export interface TaskRunProducerOptions {
  prisma: PrismaClient;
  dataGenerator: TaskRunDataGenerator;
  workerId?: string;
  targetThroughput: number;
  insertUpdateRatio: number;
  batchSize: number;
}

export class TaskRunProducer {
  private running = false;
  private totalInserts = 0;
  private totalUpdates = 0;
  private errors = 0;
  private latencies: number[] = [];
  private createdRunIds: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private startTime: number = 0;

  constructor(private readonly options: TaskRunProducerOptions) {}

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Producer is already running");
    }

    this.running = true;
    this.startTime = Date.now();
    this.resetMetrics();

    await this.runProducerLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getMetrics(): ProducerMetrics {
    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    const actualThroughput = elapsed > 0 ? (this.totalInserts + this.totalUpdates) / elapsed : 0;

    return {
      workerId: this.options.workerId,
      totalInserts: this.totalInserts,
      totalUpdates: this.totalUpdates,
      actualThroughput,
      errors: this.errors,
      latencies: [...this.latencies],
    };
  }

  private async runProducerLoop(): Promise<void> {
    while (this.running) {
      const loopStart = Date.now();

      try {
        // Determine insert vs update ratio for this batch
        const insertCount = Math.floor(this.options.batchSize * this.options.insertUpdateRatio);
        const updateCount = this.options.batchSize - insertCount;

        // Perform inserts
        if (insertCount > 0) {
          await this.performInserts(insertCount);
        }

        // Perform updates (only if we have created runs to update)
        if (updateCount > 0 && this.createdRunIds.length > 0) {
          await this.performUpdates(updateCount);
        }

        // Calculate delay to maintain target throughput
        const elapsed = Date.now() - loopStart;
        const targetDuration = (this.options.batchSize / this.options.targetThroughput) * 1000;
        const delay = Math.max(0, targetDuration - elapsed);

        if (this.running && delay > 0) {
          await new Promise((resolve) => {
            this.timer = setTimeout(resolve, delay);
          });
        }
      } catch (error) {
        console.error("Producer loop error:", error);
        this.errors++;

        // Small delay on error to prevent tight error loops
        if (this.running) {
          await new Promise((resolve) => {
            this.timer = setTimeout(resolve, 1000);
          });
        }
      }
    }
  }

  private async performInserts(count: number): Promise<void> {
    const start = performance.now();

    const records = this.options.dataGenerator.generateBatch(count);

    // Extract IDs for future updates
    const ids = records.map((r) => r.id as string);

    try {
      await this.options.prisma.taskRun.createMany({
        data: records,
        skipDuplicates: true,
      });

      this.totalInserts += count;
      this.createdRunIds.push(...ids);

      // Keep pool size manageable (max 10000 runs)
      if (this.createdRunIds.length > 10000) {
        this.createdRunIds = this.createdRunIds.slice(-10000);
      }

      const duration = performance.now() - start;
      this.latencies.push(duration);

      // Keep latencies array from growing too large
      if (this.latencies.length > 1000) {
        this.latencies = this.latencies.slice(-1000);
      }
    } catch (error) {
      console.error("Insert error:", error);
      this.errors++;
      throw error;
    }
  }

  private async performUpdates(count: number): Promise<void> {
    // Skip updates if no runs have been created yet
    if (this.createdRunIds.length === 0) {
      return;
    }

    const start = performance.now();

    // Select random runs to update
    const runIdsToUpdate = new Set<string>();
    while (runIdsToUpdate.size < count && runIdsToUpdate.size < this.createdRunIds.length) {
      const randomIndex = Math.floor(Math.random() * this.createdRunIds.length);
      runIdsToUpdate.add(this.createdRunIds[randomIndex]);
    }

    try {
      // Use a single updateMany for all updates with the same data
      // This is a simplification - in reality each update might have different data
      // but for performance testing, updating them all the same way is fine
      const updateData = this.options.dataGenerator.generateUpdate("");

      await this.options.prisma.taskRun.updateMany({
        where: {
          id: {
            in: Array.from(runIdsToUpdate),
          },
        },
        data: updateData,
      });

      this.totalUpdates += runIdsToUpdate.size;

      const duration = performance.now() - start;
      this.latencies.push(duration);

      if (this.latencies.length > 1000) {
        this.latencies = this.latencies.slice(-1000);
      }
    } catch (error) {
      console.error("Update error:", error);
      this.errors++;
      throw error;
    }
  }

  private resetMetrics(): void {
    this.totalInserts = 0;
    this.totalUpdates = 0;
    this.errors = 0;
    this.latencies = [];
    this.createdRunIds = [];
  }
}

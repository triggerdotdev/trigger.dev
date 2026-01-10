import type { PhaseMetrics, ProducerMetrics } from "./config";
import fs from "fs/promises";
import path from "path";

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

export class MetricsCollector {
  private phases: Map<string, PhaseData> = new Map();
  private currentPhase: PhaseData | null = null;

  startPhase(name: string): void {
    const phase: PhaseData = {
      name,
      startTime: Date.now(),
      endTime: null,
      producerMetrics: [],
      consumerMetrics: [],
      batchesFlushed: [],
      replicationLags: [],
    };

    this.phases.set(name, phase);
    this.currentPhase = phase;

    console.log(`\n📊 Phase started: ${name}`);
  }

  endPhase(name: string): PhaseMetrics {
    const phase = this.phases.get(name);
    if (!phase) {
      throw new Error(`Phase ${name} not found`);
    }

    phase.endTime = Date.now();
    this.currentPhase = null;

    const metrics = this.calculatePhaseMetrics(phase);
    console.log(`✅ Phase completed: ${name}`);
    this.printPhaseMetrics(metrics);

    return metrics;
  }

  recordProducerMetrics(metrics: ProducerMetrics): void {
    if (this.currentPhase) {
      this.currentPhase.producerMetrics.push({
        timestamp: Date.now(),
        ...metrics,
      });
    }
  }

  recordConsumerMetrics(metrics: ConsumerMetrics): void {
    if (this.currentPhase) {
      this.currentPhase.consumerMetrics.push({
        timestamp: Date.now(),
        ...metrics,
      });
    }
  }

  recordBatchFlushed(event: BatchFlushedEvent): void {
    if (this.currentPhase) {
      this.currentPhase.batchesFlushed.push({
        timestamp: Date.now(),
        ...event,
      });
    }
  }

  recordReplicationLag(lagMs: number): void {
    if (this.currentPhase) {
      this.currentPhase.replicationLags.push(lagMs);
    }
  }

  async exportToJSON(filePath: string): Promise<void> {
    const report = {
      timestamp: new Date().toISOString(),
      phases: Array.from(this.phases.values()).map((phase) =>
        this.calculatePhaseMetrics(phase)
      ),
    };

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(report, null, 2));

    console.log(`\n📄 Metrics exported to: ${filePath}`);
  }

  private calculatePhaseMetrics(phase: PhaseData): PhaseMetrics {
    const durationMs = phase.endTime ? phase.endTime - phase.startTime : Date.now() - phase.startTime;
    const durationSec = durationMs / 1000;

    // Producer metrics - aggregate from all workers
    // Find the most recent metric from each worker and sum them
    const latestMetricsByWorker = new Map<string, ProducerMetrics>();

    for (const metric of phase.producerMetrics) {
      const workerId = metric.workerId || "default";
      const existing = latestMetricsByWorker.get(workerId);

      // Keep the metric with the highest total (cumulative counters)
      if (!existing || (metric.totalInserts + metric.totalUpdates) > (existing.totalInserts + existing.totalUpdates)) {
        latestMetricsByWorker.set(workerId, metric);
      }
    }

    // Sum up the latest totals from each worker
    let totalInserts = 0;
    let totalUpdates = 0;

    for (const metric of latestMetricsByWorker.values()) {
      totalInserts += metric.totalInserts;
      totalUpdates += metric.totalUpdates;
    }

    const recordsProduced = totalInserts + totalUpdates;
    const producerThroughput = durationSec > 0 ? recordsProduced / durationSec : 0;

    // Consumer metrics
    const totalBatches = phase.batchesFlushed.length;
    const recordsConsumed = phase.batchesFlushed.reduce(
      (sum, batch) => sum + batch.taskRunInserts.length,
      0
    );
    const consumerThroughput = durationSec > 0 ? recordsConsumed / durationSec : 0;

    // Replication lag
    const sortedLags = [...phase.replicationLags].sort((a, b) => a - b);
    const replicationLagP50 = this.percentile(sortedLags, 0.5);
    const replicationLagP95 = this.percentile(sortedLags, 0.95);
    const replicationLagP99 = this.percentile(sortedLags, 0.99);

    // Event loop utilization (average of samples)
    const eventLoopUtilization =
      phase.consumerMetrics.length > 0
        ? phase.consumerMetrics.reduce((sum, m) => sum + m.eventLoopUtilization, 0) /
          phase.consumerMetrics.length
        : 0;

    // Memory (last sample)
    const lastConsumerMetric = phase.consumerMetrics[phase.consumerMetrics.length - 1];
    const heapUsedMB = lastConsumerMetric ? lastConsumerMetric.heapUsed / 1024 / 1024 : 0;
    const heapTotalMB = lastConsumerMetric ? lastConsumerMetric.heapTotal / 1024 / 1024 : 0;

    // Flush duration (not directly available, use placeholder)
    const flushDurationP50 = 0; // Would need to extract from OpenTelemetry metrics

    return {
      phase: phase.name,
      durationMs,
      recordsProduced,
      producerThroughput,
      batchesFlushed: totalBatches,
      recordsConsumed,
      consumerThroughput,
      replicationLagP50,
      replicationLagP95,
      replicationLagP99,
      eventLoopUtilization,
      flushDurationP50,
      heapUsedMB,
      heapTotalMB,
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  private printPhaseMetrics(metrics: PhaseMetrics): void {
    console.log("\n" + "=".repeat(60));
    console.log(`Phase: ${metrics.phase}`);
    console.log("=".repeat(60));
    console.log(`Duration:              ${(metrics.durationMs / 1000).toFixed(1)}s`);
    console.log(`Records Produced:      ${metrics.recordsProduced}`);
    console.log(`Producer Throughput:   ${metrics.producerThroughput.toFixed(1)} rec/sec`);
    console.log(`Records Consumed:      ${metrics.recordsConsumed}`);
    console.log(`Consumer Throughput:   ${metrics.consumerThroughput.toFixed(1)} rec/sec`);
    console.log(`Batches Flushed:       ${metrics.batchesFlushed}`);
    console.log(`Event Loop Util:       ${(metrics.eventLoopUtilization * 100).toFixed(1)}%`);
    console.log(`Heap Used:             ${metrics.heapUsedMB.toFixed(1)} MB`);
    console.log(`Replication Lag P50:   ${metrics.replicationLagP50.toFixed(1)} ms`);
    console.log(`Replication Lag P95:   ${metrics.replicationLagP95.toFixed(1)} ms`);
    console.log(`Replication Lag P99:   ${metrics.replicationLagP99.toFixed(1)} ms`);
    console.log("=".repeat(60) + "\n");
  }

  getAllPhases(): PhaseMetrics[] {
    return Array.from(this.phases.values()).map((phase) => this.calculatePhaseMetrics(phase));
  }
}

interface PhaseData {
  name: string;
  startTime: number;
  endTime: number | null;
  producerMetrics: Array<{ timestamp: number } & ProducerMetrics>;
  consumerMetrics: Array<{ timestamp: number } & ConsumerMetrics>;
  batchesFlushed: Array<{ timestamp: number } & BatchFlushedEvent>;
  replicationLags: number[];
}

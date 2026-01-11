import { RedisOptions } from "ioredis";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { config as loadEnv } from "dotenv";
import path from "path";

// Load local environment variables for profiling (override existing vars)
loadEnv({ path: path.join(__dirname, ".env.local"), override: true });

export interface TestPhase {
  name: string;
  durationSec: number;
  targetThroughput: number; // records/sec
}

export interface ProducerConfig {
  enabled: boolean;
  workerCount: number; // Number of parallel producer processes
  workerId?: string; // Unique identifier for this specific worker
  targetThroughput: number;
  insertUpdateRatio: number; // 0.0-1.0, e.g. 0.8 = 80% inserts, 20% updates
  batchSize: number;
  payloadSizeKB: number;
  databaseUrl: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  environmentType: RuntimeEnvironmentType;
}

export interface ConsumerConfig {
  flushBatchSize: number;
  flushIntervalMs: number;
  maxFlushConcurrency: number;
  useMockClickhouse: boolean;
  mockClickhouseDelay: number; // milliseconds
  pgConnectionUrl: string;
  clickhouseUrl?: string;
  redisOptions: RedisOptions;
  slotName: string;
  publicationName: string;
  outputDir?: string; // For shutdown signal file
}

export interface ProfilingConfig {
  enabled: boolean;
  tool: "doctor" | "flame" | "both" | "none";
  outputDir: string;
}

export interface OutputConfig {
  metricsFile: string;
  verbose: boolean;
}

export interface InfrastructureConfig {
  databaseUrl: string;
  profilingDatabaseName?: string; // Defaults to "trigger_profiling"
  redisUrl?: string;
  clickhouseUrl?: string;
}

export interface HarnessConfig {
  runName: string; // Short identifier for this run (e.g. "baseline", "optimized-v1")
  runDescription?: string; // Optional longer description of what this run is testing
  phases: TestPhase[];
  producer: ProducerConfig;
  consumer: ConsumerConfig;
  profiling: ProfilingConfig;
  output: OutputConfig;
  infrastructure: InfrastructureConfig;
}

export function getDefaultConfig(): Partial<HarnessConfig> {
  return {
    runName: "default",
    runDescription: undefined,
    phases: [
      {
        name: "warmup",
        durationSec: 30,
        targetThroughput: 1000,
      },
      {
        name: "baseline",
        durationSec: 60,
        targetThroughput: 5000,
      },
    ],
    producer: {
      enabled: true,
      workerCount: 1,
      targetThroughput: 5000,
      insertUpdateRatio: 0.8,
      batchSize: 500,
      payloadSizeKB: 1,
      databaseUrl: "",
      organizationId: "",
      projectId: "",
      runtimeEnvironmentId: "",
      environmentType: "DEVELOPMENT",
    },
    consumer: {
      flushBatchSize: 50,
      flushIntervalMs: 100,
      maxFlushConcurrency: 100,
      useMockClickhouse: false,
      mockClickhouseDelay: 0,
      pgConnectionUrl: "",
      slotName: "profiling_slot",
      publicationName: "profiling_publication",
      redisOptions: {},
    },
    profiling: {
      enabled: false,
      tool: "none",
      outputDir: "./profiling-results",
    },
    output: {
      metricsFile: "metrics.json",
      verbose: false,
    },
    infrastructure: {
      databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres",
      profilingDatabaseName: "trigger_profiling",
      redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
      clickhouseUrl: process.env.CLICKHOUSE_URL,
    },
  };
}

export interface ProducerMetrics {
  workerId?: string; // Unique identifier for this producer worker
  totalInserts: number;
  totalUpdates: number;
  actualThroughput: number;
  errors: number;
  latencies: number[]; // for calculating percentiles
}

export interface PhaseMetrics {
  phase: string;
  durationMs: number;

  // Producer
  recordsProduced: number;
  producerThroughput: number;

  // Consumer
  batchesFlushed: number;
  recordsConsumed: number;
  consumerThroughput: number;
  replicationLagP50: number;
  replicationLagP95: number;
  replicationLagP99: number;

  // Performance
  eventLoopUtilization: number;
  flushDurationP50: number;

  // Memory
  heapUsedMB: number;
  heapTotalMB: number;
}

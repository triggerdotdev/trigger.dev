import { PrismaClient } from "@trigger.dev/database";
import { ConsumerProcessManager, ProducerProcessManager } from "./consumer";
import { MetricsCollector } from "./metrics-collector";
import type { HarnessConfig, PhaseMetrics } from "./config";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";

export class RunsReplicationHarness {
  private prisma: PrismaClient | null = null;
  private adminPrisma: PrismaClient | null = null;
  private producerProcesses: ProducerProcessManager[] = [];
  private consumerProcess: ConsumerProcessManager | null = null;
  private metricsCollector: MetricsCollector;

  private organizationId: string = "";
  private projectId: string = "";
  private runtimeEnvironmentId: string = "";
  private profilingDatabaseUrl: string = "";

  constructor(private readonly config: HarnessConfig) {
    this.metricsCollector = new MetricsCollector();
  }

  async setup(): Promise<void> {
    console.log("\n🚀 Setting up profiling database...\n");

    const dbName = this.config.infrastructure.profilingDatabaseName || "trigger_profiling";

    // 1. Create profiling database
    console.log(`Creating database: ${dbName}...`);
    await this.createProfilingDatabase(dbName);

    // 2. Build profiling database URL
    this.profilingDatabaseUrl = this.buildProfilingDatabaseUrl(
      this.config.infrastructure.databaseUrl,
      dbName
    );
    console.log(`Profiling database URL: ${this.maskPassword(this.profilingDatabaseUrl)}`);

    // 3. Initialize Prisma for profiling database
    console.log("Initializing Prisma...");
    this.prisma = new PrismaClient({
      datasources: {
        db: {
          url: this.profilingDatabaseUrl,
        },
      },
    });

    // 4. Run migrations
    console.log("Running database migrations...");
    await this.runMigrations();

    // 5. Truncate existing TaskRun data for clean slate
    console.log("Truncating existing TaskRun data...");
    await this.prisma!.$executeRawUnsafe(`TRUNCATE TABLE public."TaskRun" CASCADE;`);
    console.log("✅ TaskRun table truncated");

    // 6. Configure replication
    console.log("Configuring logical replication...");
    await this.setupReplication();

    // 7. Set up test fixtures
    console.log("Setting up test fixtures...");
    await this.setupTestFixtures();

    // 7. Parse Redis URL
    const redisUrl = this.config.infrastructure.redisUrl || "redis://localhost:6379";
    const parsedRedis = this.parseRedisUrl(redisUrl);

    // 8. Update config
    this.config.producer.databaseUrl = this.profilingDatabaseUrl;
    this.config.producer.organizationId = this.organizationId;
    this.config.producer.projectId = this.projectId;
    this.config.producer.runtimeEnvironmentId = this.runtimeEnvironmentId;

    this.config.consumer.pgConnectionUrl = this.profilingDatabaseUrl;
    this.config.consumer.redisOptions = parsedRedis;

    if (!this.config.consumer.useMockClickhouse) {
      if (!this.config.infrastructure.clickhouseUrl) {
        throw new Error(
          "Real ClickHouse mode requires clickhouseUrl in config or CLICKHOUSE_URL env var"
        );
      }
      this.config.consumer.clickhouseUrl = this.config.infrastructure.clickhouseUrl;
      console.log("ClickHouse URL:", this.maskPassword(this.config.consumer.clickhouseUrl));

      // Run ClickHouse migrations
      console.log("Running ClickHouse migrations...");
      await this.runClickHouseMigrations();
      console.log("✅ ClickHouse migrations completed");
    } else {
      console.log("Using mock ClickHouse (CPU-only profiling)");
    }

    // 9. Start consumer process
    console.log("\nStarting consumer process...");
    // Set outputDir for shutdown signal file (needed when IPC isn't available under Clinic.js)
    this.config.consumer.outputDir = this.config.profiling.outputDir;

    this.consumerProcess = new ConsumerProcessManager(
      this.config.consumer,
      this.config.profiling
    );

    this.consumerProcess.setOnMetrics((metrics) => {
      this.metricsCollector.recordConsumerMetrics(metrics);
    });

    this.consumerProcess.setOnBatchFlushed((event) => {
      this.metricsCollector.recordBatchFlushed(event);
    });

    this.consumerProcess.setOnError((error) => {
      console.error("Consumer error:", error);
    });

    await this.consumerProcess.start();

    // 10. Start producer processes (multiple workers for high throughput)
    const workerCount = this.config.producer.workerCount;
    console.log(`Starting ${workerCount} producer process(es)...`);

    for (let i = 0; i < workerCount; i++) {
      const workerConfig = { ...this.config.producer };
      // Each worker gets a unique ID and a portion of the total throughput
      workerConfig.workerId = `worker-${i + 1}`;
      workerConfig.targetThroughput = this.config.producer.targetThroughput / workerCount;

      const producerProcess = new ProducerProcessManager(workerConfig);

      producerProcess.setOnMetrics((metrics) => {
        this.metricsCollector.recordProducerMetrics(metrics);
      });

      producerProcess.setOnError((error) => {
        console.error(`Producer worker ${i + 1} error:`, error);
      });

      await producerProcess.start();
      this.producerProcesses.push(producerProcess);

      console.log(`  ✓ Producer worker ${i + 1}/${workerCount} started (target: ${workerConfig.targetThroughput.toFixed(0)} rec/sec)`);
    }

    console.log("\n✅ Profiling environment ready!\n");
  }

  async run(): Promise<PhaseMetrics[]> {
    console.log("\n▶️  Starting test phases...\n");

    for (const phase of this.config.phases) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Phase: ${phase.name}`);
      console.log(`Duration: ${phase.durationSec}s | Target: ${phase.targetThroughput} rec/sec`);
      console.log(`${"=".repeat(60)}\n`);

      this.metricsCollector.startPhase(phase.name);

      // Start all producer workers
      const perWorkerThroughput = phase.targetThroughput / this.producerProcesses.length;
      for (const producer of this.producerProcesses) {
        producer.send({
          type: "start",
          throughput: perWorkerThroughput,
        });
      }

      // Wait for phase duration
      await this.waitWithProgress(phase.durationSec * 1000);

      // Stop all producer workers
      for (const producer of this.producerProcesses) {
        producer.send({ type: "stop" });
      }
      console.log("\nAll producers stopped, waiting for consumer to catch up...");

      // Wait for consumer to catch up
      await this.waitForReplicationLag(100, 60000);

      this.metricsCollector.endPhase(phase.name);

      // Small pause between phases
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log("\n✅ All phases completed!\n");
    return this.metricsCollector.getAllPhases();
  }

  async teardown(): Promise<void> {
    console.log("\n🧹 Tearing down...\n");

    if (this.producerProcesses.length > 0) {
      console.log(`Stopping ${this.producerProcesses.length} producer process(es)...`);
      await Promise.all(this.producerProcesses.map((p) => p.stop()));
    }

    if (this.consumerProcess) {
      console.log("Stopping consumer process...");
      await this.consumerProcess.stop();
    }

    if (this.prisma) {
      console.log("Disconnecting Prisma...");
      await this.prisma.$disconnect();
    }

    if (this.adminPrisma) {
      await this.adminPrisma.$disconnect();
    }

    console.log("\n✅ Teardown complete!\n");
    console.log(`💡 Profiling database '${this.config.infrastructure.profilingDatabaseName}' is preserved for inspection.`);
    console.log(`   To clean up: DROP DATABASE ${this.config.infrastructure.profilingDatabaseName};`);
  }

  async exportMetrics(filePath: string): Promise<void> {
    await this.metricsCollector.exportToJSON(filePath);
  }

  private async createProfilingDatabase(dbName: string): Promise<void> {
    // Connect to default database to create profiling database
    const baseUrl = this.config.infrastructure.databaseUrl;

    this.adminPrisma = new PrismaClient({
      datasources: {
        db: {
          url: baseUrl,
        },
      },
    });

    // Check if database exists
    const exists = await this.adminPrisma.$queryRaw<Array<{ datname: string }>>`
      SELECT datname FROM pg_database WHERE datname = ${dbName};
    `;

    if (exists.length === 0) {
      // Create database
      await this.adminPrisma.$executeRawUnsafe(`CREATE DATABASE ${dbName};`);
      console.log(`✅ Created database: ${dbName}`);
    } else {
      console.log(`✅ Database already exists: ${dbName}`);
    }
  }

  private buildProfilingDatabaseUrl(baseUrl: string, dbName: string): string {
    // Parse the base URL and replace the database name
    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    return url.toString();
  }

  private async runMigrations(): Promise<void> {
    try {
      // Use pg_dump to copy schema from main database to profiling database
      const baseUrl = this.config.infrastructure.databaseUrl;
      const dbName = this.config.infrastructure.profilingDatabaseName || "trigger_profiling";

      console.log("Copying schema from main database to profiling database...");

      // Strip query parameters from URLs (pg_dump doesn't support them)
      const cleanBaseUrl = baseUrl.split("?")[0];
      const cleanProfilingUrl = this.profilingDatabaseUrl.split("?")[0];

      // Dump schema only (no data) from main database
      execSync(
        `pg_dump "${cleanBaseUrl}" --schema-only --no-owner --no-acl | psql "${cleanProfilingUrl}" > /dev/null 2>&1`,
        { shell: "/bin/bash" }
      );

      console.log("✅ Schema copied successfully");
    } catch (error) {
      console.error("❌ Schema copy failed:", error);
      throw error;
    }
  }

  private async setupReplication(): Promise<void> {
    // Set REPLICA IDENTITY FULL
    await this.prisma!.$executeRawUnsafe(
      `ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`
    );

    // Drop existing replication slot if it exists (ensures clean slate)
    const slotExists = await this.prisma!.$queryRaw<
      Array<{ slot_name: string; active: boolean; active_pid: number | null }>
    >`
      SELECT slot_name, active, active_pid FROM pg_replication_slots WHERE slot_name = ${this.config.consumer.slotName};
    `;

    if (slotExists.length > 0) {
      const slot = slotExists[0];
      console.log(`🧹 Dropping existing replication slot: ${this.config.consumer.slotName}`);

      // If the slot is active, terminate the backend process first
      if (slot.active && slot.active_pid) {
        console.log(
          `⚠️  Replication slot is active for PID ${slot.active_pid}, terminating backend...`
        );
        try {
          await this.prisma!.$executeRawUnsafe(
            `SELECT pg_terminate_backend(${slot.active_pid});`
          );
          console.log(`✅ Terminated backend process ${slot.active_pid}`);

          // Wait a bit for the termination to complete
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.warn(
            `⚠️  Could not terminate backend ${slot.active_pid}, it may have already exited`
          );
        }
      }

      // Now try to drop the slot with retry logic
      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < maxAttempts) {
        try {
          await this.prisma!.$executeRawUnsafe(
            `SELECT pg_drop_replication_slot('${this.config.consumer.slotName}');`
          );
          console.log(`✅ Dropped replication slot: ${this.config.consumer.slotName}`);
          break;
        } catch (error: any) {
          attempts++;
          if (attempts === maxAttempts) {
            throw new Error(
              `Failed to drop replication slot after ${maxAttempts} attempts: ${error.message}`
            );
          }
          console.log(
            `⚠️  Slot still active, waiting 2s before retry (attempt ${attempts}/${maxAttempts})...`
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // Drop and recreate publication (ensures clean slate)
    const pubExists = await this.prisma!.$queryRaw<Array<{ pubname: string }>>`
      SELECT pubname FROM pg_publication WHERE pubname = ${this.config.consumer.publicationName};
    `;

    if (pubExists.length > 0) {
      console.log(`🧹 Dropping existing publication: ${this.config.consumer.publicationName}`);
      await this.prisma!.$executeRawUnsafe(
        `DROP PUBLICATION ${this.config.consumer.publicationName};`
      );
    }

    // Create fresh publication
    await this.prisma!.$executeRawUnsafe(
      `CREATE PUBLICATION ${this.config.consumer.publicationName} FOR TABLE "TaskRun";`
    );
    console.log(`✅ Created publication: ${this.config.consumer.publicationName}`);

    // Create fresh replication slot
    await this.prisma!.$executeRawUnsafe(
      `SELECT pg_create_logical_replication_slot('${this.config.consumer.slotName}', 'pgoutput');`
    );
    console.log(`✅ Created replication slot: ${this.config.consumer.slotName}`);
  }

  private async setupTestFixtures(): Promise<void> {
    // Try to find existing profiling fixtures
    let org = await this.prisma!.organization.findFirst({
      where: {
        slug: {
          startsWith: "perf-test-",
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!org) {
      org = await this.prisma!.organization.create({
        data: {
          title: "Performance Test Org",
          slug: `perf-test-${Date.now()}`,
        },
      });
      console.log(`Created organization: ${org.id}`);
    } else {
      console.log(`Using existing organization: ${org.id}`);
    }

    this.organizationId = org.id;

    // Find or create project
    let project = await this.prisma!.project.findFirst({
      where: {
        organizationId: org.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!project) {
      project = await this.prisma!.project.create({
        data: {
          name: "Performance Test Project",
          slug: `perf-test-${Date.now()}`,
          organizationId: org.id,
          externalRef: `perf-test-${Date.now()}`,
        },
      });
      console.log(`Created project: ${project.id}`);
    } else {
      console.log(`Using existing project: ${project.id}`);
    }

    this.projectId = project.id;

    // Find or create runtime environment
    let env = await this.prisma!.runtimeEnvironment.findFirst({
      where: {
        projectId: project.id,
        type: "DEVELOPMENT",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!env) {
      env = await this.prisma!.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: org.id,
          apiKey: `test-key-${Date.now()}`,
          pkApiKey: `pk-test-${Date.now()}`,
          shortcode: `dev-${Date.now()}`,
        },
      });
      console.log(`Created environment: ${env.id}`);
    } else {
      console.log(`Using existing environment: ${env.id}`);
    }

    this.runtimeEnvironmentId = env.id;

    console.log(`\n✅ Test fixtures ready:`);
    console.log(`   Organization: ${this.organizationId}`);
    console.log(`   Project:      ${this.projectId}`);
    console.log(`   Environment:  ${this.runtimeEnvironmentId}`);
  }

  private parseRedisUrl(url: string): any {
    const match = url.match(/^redis:\/\/(?::([^@]+)@)?([^:]+):(\d+)/);
    if (!match) {
      return {
        host: "localhost",
        port: 6379,
      };
    }

    return {
      host: match[2],
      port: parseInt(match[3], 10),
      password: match[1] || undefined,
    };
  }

  private async waitForReplicationLag(maxLagMs: number, timeoutMs: number): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (Date.now() - start > 5000) {
        console.log("✅ Consumer caught up (approximated)");
        return;
      }
    }

    console.warn("⚠️  Timeout waiting for replication to catch up");
  }

  private async waitWithProgress(durationMs: number): Promise<void> {
    const start = Date.now();
    const interval = 5000;

    while (Date.now() - start < durationMs) {
      const elapsed = Date.now() - start;
      const remaining = durationMs - elapsed;
      const progress = (elapsed / durationMs) * 100;

      process.stdout.write(
        `\rProgress: ${progress.toFixed(1)}% | Remaining: ${(remaining / 1000).toFixed(0)}s`
      );

      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
    }

    process.stdout.write("\n");
  }

  private async runClickHouseMigrations(): Promise<void> {
    // Use dynamic import to avoid module resolution issues with tsx
    const { ClickHouse } = await import("@internal/clickhouse");

    const clickhouse = new ClickHouse({
      url: this.config.infrastructure.clickhouseUrl!,
      name: "profiling-migrator",
      logLevel: "error", // Suppress migration spam - we handle errors ourselves
    });

    try {
      // Path to migration files (relative to apps/webapp/test/performance)
      const migrationsPath = path.join(__dirname, "../../../../internal-packages/clickhouse/schema");

      // Read all SQL files in order
      const files = await fs.readdir(migrationsPath);
      const sqlFiles = files
        .filter((f) => f.endsWith(".sql"))
        .sort(); // Ensure numeric ordering

      // Suppress verbose output - only show errors
      let successCount = 0;
      let skippedCount = 0;

      for (const file of sqlFiles) {
        const sql = await fs.readFile(path.join(migrationsPath, file), "utf-8");

        // Parse goose migration file - only execute "up" section
        const lines = sql.split("\n");
        let inUpSection = false;
        const upSql: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          const lowerTrimmed = trimmed.toLowerCase();

          // Check for section markers (case-insensitive)
          if (lowerTrimmed.includes("+goose up")) {
            inUpSection = true;
            continue;
          }
          if (lowerTrimmed.includes("+goose down")) {
            inUpSection = false;
            break; // Stop processing, we only want the "up" section
          }

          // Add lines from the "up" section
          if (inUpSection && trimmed) {
            // Skip standalone comment lines (but keep inline comments and /* */ blocks)
            if (trimmed.startsWith("--")) {
              continue;
            }
            upSql.push(line);
          }
        }

        // Join and split by semicolons
        const statements = upSql
          .join("\n")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const statement of statements) {
          try {
            // Use the underlying client's command method
            await (clickhouse.writer as any).client.command({ query: statement });
            successCount++;
          } catch (error: any) {
            // Ignore "already exists" errors silently
            if (
              error.message?.includes("already exists") ||
              error.message?.includes("ALREADY_EXISTS") ||
              error.code === "57"
            ) {
              skippedCount++;
            } else {
              console.error(`✗ Migration error in ${file}: ${error.message}`);
              throw error;
            }
          }
        }
      }

      if (successCount > 0 || skippedCount > 0) {
        console.log(`Migrations: ${successCount} applied, ${skippedCount} skipped`);
      }
    } finally {
      await clickhouse.close();
    }
  }

  private maskPassword(url: string): string {
    return url.replace(/\/\/.*@/, "//***:***@");
  }
}

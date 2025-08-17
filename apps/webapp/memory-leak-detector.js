#!/usr/bin/env node

/**
 * Memory Leak Detector for Trigger.dev Webapp
 *
 * This script starts the server, performs memory snapshots, executes API requests,
 * and analyzes memory usage patterns to detect potential memory leaks.
 *
 * Usage: node memory-leak-detector.js [options]
 */

const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { performance } = require("perf_hooks");

class MemoryLeakDetector {
  constructor(options = {}) {
    // Create timestamped directory for this run
    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseDir = options.baseDir || "./.memory-snapshots";
    const runDir = `${baseDir}/${runTimestamp}-${options.label || "memory-leak-detector"}`;

    this.options = {
      // Server configuration
      serverPort: options.serverPort || 3030,
      serverStartTimeout: options.serverStartTimeout || 30000,

      // Sentry configuration
      sentryDsn: options.sentryDsn || "",

      // Memory snapshot configuration
      heapSnapshotPath: `${runDir}/snapshots`,
      adminToken: options.adminToken, // Bearer token for admin API access

      apiKey: options.apiKey,

      // Testing configuration
      warmupRequests: options.warmupRequests || 10,
      testRequests: options.testRequests || 100,
      requestDelay: options.requestDelay || 50, // ms between requests
      requestTimeout: options.requestTimeout || 5000,

      // API endpoints to test (configurable)
      apiEndpoints: options.apiEndpoints || ["/api/v1/runs"],
      postApiEndpoints: options.postApiEndpoints || ["/api/v1/mock"],

      // Memory analysis thresholds
      memoryLeakThreshold: options.memoryLeakThreshold || 50, // MB increase
      heapGrowthThreshold: options.heapGrowthThreshold || 0.2, // 20% growth

      // Output configuration
      verbose: options.verbose || false,
      outputFile: `${runDir}/memory-leak-report.json`,
      runDir: runDir,
      runTimestamp: runTimestamp,

      ...options,
    };

    this.serverProcess = null;
    this.results = {
      startTime: new Date().toISOString(),
      runTimestamp: runTimestamp,
      runDirectory: runDir,
      serverInfo: {},
      snapshots: [],
      testPhases: [], // Track each phase of testing
      totalRequests: {
        warmup: 0,
        phase1: 0,
        phase2: 0,
        successful: 0,
        failed: 0,
        errors: [],
      },
      memoryAnalysis: {},
      recommendations: [],
    };
  }

  log(message, level = "info") {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (this.options.verbose || level === "info") {
      console.log(`${prefix} ${message}`);
    }
  }

  async ensureSnapshotDir() {
    if (!fs.existsSync(this.options.runDir)) {
      fs.mkdirSync(this.options.runDir, { recursive: true });
      this.log(`Created run directory: ${this.options.runDir}`);
    }
    if (!fs.existsSync(this.options.heapSnapshotPath)) {
      fs.mkdirSync(this.options.heapSnapshotPath, { recursive: true });
      this.log(`Created snapshot directory: ${this.options.heapSnapshotPath}`);
    }
  }

  async takeHeapSnapshot(label) {
    const timestamp = Date.now();
    const filename = `heap-${label}-${timestamp}.heapsnapshot`;
    const filepath = path.join(this.options.heapSnapshotPath, filename);

    try {
      let snapshotData;

      if (this.options.adminToken) {
        this.log(`Running GC before snapshot...`);
        await this.runGc();

        // Use the admin API endpoint to get actual V8 heap snapshot
        this.log(`Taking V8 heap snapshot via admin API: ${label}...`);

        snapshotData = await this.takeV8HeapSnapshot(label, filepath, timestamp);
      } else {
        // Fallback to basic memory usage info
        this.log(`Taking basic memory snapshot: ${label} (no admin token provided)...`);

        const memUsage = process.memoryUsage();
        snapshotData = {
          label,
          timestamp,
          filename: filename.replace(".heapsnapshot", ".json"),
          filepath: filepath.replace(".heapsnapshot", ".json"),
          processMemory: memUsage,
          type: "basic",
        };

        fs.writeFileSync(snapshotData.filepath, JSON.stringify(snapshotData, null, 2));
      }

      this.results.snapshots.push(snapshotData);
      this.log(`Snapshot completed: ${label}`);

      return snapshotData;
    } catch (error) {
      this.log(`Failed to take heap snapshot: ${error.message}`, "error");
      throw error;
    }
  }

  async takeV8HeapSnapshot(label, filepath, timestamp) {
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: "localhost",
        port: this.options.serverPort,
        path: "/admin/api/v1/snapshot",
        method: "GET",
        timeout: 120000, // Heap snapshots can take a while
        headers: {
          Authorization: `Bearer ${this.options.adminToken}`,
          "User-Agent": "memory-leak-detector/1.0",
        },
      };

      const req = http.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Admin API returned ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        const writeStream = fs.createWriteStream(filepath);
        let downloadedBytes = 0;

        res.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          this.log(`Downloaded ${downloadedBytes} bytes`);
          writeStream.write(chunk);
        });

        res.on("end", () => {
          writeStream.end();

          const snapshotData = {
            label,
            timestamp,
            filename: path.basename(filepath),
            filepath,
            size: downloadedBytes,
            type: "v8-heapsnapshot",
          };

          this.log(`V8 heap snapshot saved: ${Math.round(downloadedBytes / 1024 / 1024)}MB`);
          resolve(snapshotData);
        });

        res.on("error", (error) => {
          writeStream.destroy();
          fs.unlink(filepath, () => {}); // Clean up partial file
          reject(error);
        });

        writeStream.on("error", (error) => {
          res.destroy();
          reject(error);
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Failed to connect to admin API: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Admin API request timeout"));
      });

      req.end();
    });
  }

  async runGc() {
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: "localhost",
        port: this.options.serverPort,
        path: "/admin/api/v1/gc",
        method: "GET",
        timeout: 120000, // GC can take a while
        headers: {
          Authorization: `Bearer ${this.options.adminToken}`,
          "User-Agent": "memory-leak-detector/1.0",
        },
      };

      const req = http.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Admin API returned ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        res.on("data", (chunk) => {
          this.log(`GC run completed`);
        });

        res.on("end", () => {
          resolve();
        });

        res.on("error", (error) => {
          reject(error);
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Failed to connect to admin API: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Admin API request timeout"));
      });

      req.end();
    });
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      this.log("Starting server...");

      // First, build the project
      const buildProcess = spawn("npm", ["run", "build"], {
        cwd: process.cwd(),
        stdio: this.options.verbose ? "inherit" : "pipe",
      });

      buildProcess.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Build failed with code ${code}`));
          return;
        }

        this.log("Build completed, starting server...");

        const nodePath = path.resolve(process.cwd(), "../../node_modules/.pnpm/node_modules");

        this.log(`Using NODE_PATH: ${nodePath}`);

        // Start the server with memory inspection flags
        this.serverProcess = spawn(
          "node",
          ["--max-old-space-size=16384", "--expose-gc", "./build/server.js"],
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              NODE_ENV: "production",
              NODE_PATH: nodePath,
              PORT: this.options.serverPort,
              // Disable Sentry to prevent memory leaks from it
              SENTRY_DSN: this.options.sentryDsn,
            },
          }
        );

        let serverReady = false;
        const timeout = setTimeout(() => {
          if (!serverReady) {
            this.serverProcess.kill();
            reject(new Error("Server failed to start within timeout"));
          }
        }, this.options.serverStartTimeout);

        this.serverProcess.stdout.on("data", (data) => {
          const output = data.toString();
          if (this.options.verbose) {
            console.log("SERVER:", output.trim());
          }

          if (output.includes("server ready") && !serverReady) {
            serverReady = true;
            clearTimeout(timeout);

            this.results.serverInfo = {
              port: this.options.serverPort,
              startTime: Date.now(),
              nodeVersion: process.version,
            };

            this.log(`Server started on port ${this.options.serverPort}`);

            // Wait a bit more for server to fully initialize
            setTimeout(() => resolve(), 2000);
          }
        });

        this.serverProcess.stderr.on("data", (data) => {
          const error = data.toString();
          if (this.options.verbose || error.includes("Error")) {
            console.error("SERVER ERROR:", error.trim());
          }
        });

        this.serverProcess.on("close", (code) => {
          if (!serverReady && code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Server process exited with code ${code}`));
          }
        });
      });
    });
  }

  async makeRequest(endpoint, options = {}) {
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: "localhost",
        port: this.options.serverPort,
        path: endpoint,
        method: options.method || "GET",
        timeout: this.options.requestTimeout,
        headers: {
          "User-Agent": "memory-leak-detector/1.0",
          Accept: "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
          ...options.headers,
        },
      };

      const req = http.request(requestOptions, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
            endpoint: endpoint,
          });
        });
      });

      req.on("error", (error) => {
        reject({ error, endpoint });
      });

      req.on("timeout", () => {
        req.destroy();
        reject({ error: new Error("Request timeout"), endpoint });
      });

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  async performRequestPhase(phaseName, numRequests) {
    this.log(`Starting ${phaseName} phase with ${numRequests} GET requests...`);

    const startTime = performance.now();
    let successfulRequests = 0;
    let failedRequests = 0;
    const errors = [];

    for (let i = 0; i < numRequests; i++) {
      const endpoint = this.options.apiEndpoints[i % this.options.apiEndpoints.length];

      try {
        const response = await this.makeRequest(endpoint);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          successfulRequests++;
        } else {
          failedRequests++;
          errors.push({
            endpoint,
            statusCode: response.statusCode,
            error: `HTTP ${response.statusCode}`,
            phase: phaseName,
          });
        }
      } catch (error) {
        failedRequests++;
        errors.push({
          endpoint: error.endpoint,
          error: error.error?.message || "Unknown error",
          phase: phaseName,
        });
      }

      // Add delay between requests
      if (i < numRequests - 1) {
        await this.delay(this.options.requestDelay);
      }

      // Progress reporting
      if (this.options.verbose && numRequests > 25 && (i + 1) % 25 === 0) {
        this.log(`${phaseName}: ${i + 1}/${numRequests} requests completed`);
      }
    }

    this.log(`Continuing with ${phaseName} phase with ${numRequests} POST requests...`);

    for (let i = 0; i < numRequests; i++) {
      const endpoint = this.options.postApiEndpoints[i % this.options.postApiEndpoints.length];

      try {
        // Send a LARGE body to try and trigger a memory leak
        const response = await this.makeRequest(endpoint, {
          method: "POST",
          body: JSON.stringify(
            Array.from({ length: 1000 }, (_, index) => ({
              id: index,
              name: `Mock ${index}`,
              description: `Mock ${index} description`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              uuid: crypto.randomUUID(),
            }))
          ),
        });

        if (response.statusCode >= 200 && response.statusCode < 300) {
          successfulRequests++;
        } else {
          failedRequests++;
          errors.push({
            endpoint,
            statusCode: response.statusCode,
            error: `HTTP ${response.statusCode}`,
            phase: phaseName,
          });
        }
      } catch (error) {
        failedRequests++;
        errors.push({
          endpoint: error.endpoint,
          error: error.error?.message || "Unknown error",
          phase: phaseName,
        });
      }

      // Add delay between requests
      if (i < numRequests - 1) {
        await this.delay(this.options.requestDelay);
      }

      // Progress reporting
      if (this.options.verbose && numRequests > 25 && (i + 1) % 25 === 0) {
        this.log(`${phaseName}: ${i + 1}/${numRequests} requests completed`);
      }
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    const phaseResults = {
      phase: phaseName,
      total: numRequests,
      successful: successfulRequests,
      failed: failedRequests,
      errors: errors.slice(0, 5), // Keep only first 5 errors per phase
      duration: Math.round(duration),
      requestsPerSecond: Math.round((numRequests / duration) * 1000),
    };

    this.results.testPhases.push(phaseResults);

    // Update totals
    this.results.totalRequests.successful += successfulRequests;
    this.results.totalRequests.failed += failedRequests;
    this.results.totalRequests.errors.push(...errors.slice(0, 3));

    if (phaseName === "warmup") {
      this.results.totalRequests.warmup = numRequests;
    } else if (phaseName === "load-test-1") {
      this.results.totalRequests.phase1 = numRequests;
    } else if (phaseName === "load-test-2") {
      this.results.totalRequests.phase2 = numRequests;
    }

    this.log(
      `${phaseName} completed: ${successfulRequests}/${numRequests} successful (${Math.round(
        duration
      )}ms total)`
    );

    return phaseResults;
  }

  analyzeMemoryUsage() {
    if (this.results.snapshots.length < 3) {
      this.log("Need at least 3 snapshots to analyze memory usage", "warn");
      return;
    }

    const snapshot1 = this.results.snapshots[0]; // after warmup
    const snapshot2 = this.results.snapshots[1]; // after first load test
    const snapshot3 = this.results.snapshots[2]; // after second load test

    let analysis = {};

    // Handle different snapshot types
    if (
      snapshot1.type === "v8-heapsnapshot" &&
      snapshot2.type === "v8-heapsnapshot" &&
      snapshot3.type === "v8-heapsnapshot"
    ) {
      const size1 = snapshot1.size || 0;
      const size2 = snapshot2.size || 0;
      const size3 = snapshot3.size || 0;

      const growth1to2 = size2 - size1;
      const growth2to3 = size3 - size2;
      const totalGrowth = size3 - size1;

      const growth1to2Percent = size1 > 0 ? (growth1to2 / size1) * 100 : 0;
      const growth2to3Percent = size2 > 0 ? (growth2to3 / size2) * 100 : 0;
      const totalGrowthPercent = size1 > 0 ? (totalGrowth / size1) * 100 : 0;

      analysis = {
        snapshotAnalysis: {
          type: "v8-heapsnapshot",
          phase1: {
            size: Math.round(size1 / 1024 / 1024),
            file: snapshot1.filename,
          },
          phase2: {
            size: Math.round(size2 / 1024 / 1024),
            file: snapshot2.filename,
            growthFromPhase1: Math.round(growth1to2 / 1024 / 1024),
            growthPercentFromPhase1: Math.round(growth1to2Percent * 100) / 100,
          },
          phase3: {
            size: Math.round(size3 / 1024 / 1024),
            file: snapshot3.filename,
            growthFromPhase2: Math.round(growth2to3 / 1024 / 1024),
            growthPercentFromPhase2: Math.round(growth2to3Percent * 100) / 100,
          },
          total: {
            growth: Math.round(totalGrowth / 1024 / 1024),
            growthPercent: Math.round(totalGrowthPercent * 100) / 100,
          },
        },
        snapshots: this.results.snapshots.length,
        snapshotPaths: this.results.snapshots.map((s) => s.filepath),
      };

      // Use total growth for recommendations
      var heapGrowth = totalGrowth;
      var heapGrowthPercent = totalGrowthPercent;
    } else if (snapshot1.processMemory && snapshot2.processMemory && snapshot3.processMemory) {
      // Traditional process memory analysis with 3 snapshots
      const heap1 = snapshot1.processMemory.heapUsed;
      const heap2 = snapshot2.processMemory.heapUsed;
      const heap3 = snapshot3.processMemory.heapUsed;
      const rss1 = snapshot1.processMemory.rss;
      const rss2 = snapshot2.processMemory.rss;
      const rss3 = snapshot3.processMemory.rss;

      const heapGrowth1to2 = heap2 - heap1;
      const heapGrowth2to3 = heap3 - heap2;
      const totalHeapGrowth = heap3 - heap1;
      const rssGrowth1to2 = rss2 - rss1;
      const rssGrowth2to3 = rss3 - rss2;
      const totalRssGrowth = rss3 - rss1;

      analysis = {
        heapUsage: {
          phase1: Math.round(heap1 / 1024 / 1024),
          phase2: Math.round(heap2 / 1024 / 1024),
          phase3: Math.round(heap3 / 1024 / 1024),
          growth1to2: Math.round(heapGrowth1to2 / 1024 / 1024),
          growth2to3: Math.round(heapGrowth2to3 / 1024 / 1024),
          totalGrowth: Math.round(totalHeapGrowth / 1024 / 1024),
          totalGrowthPercent: Math.round((totalHeapGrowth / heap1) * 100 * 100) / 100,
        },
        rssUsage: {
          phase1: Math.round(rss1 / 1024 / 1024),
          phase2: Math.round(rss2 / 1024 / 1024),
          phase3: Math.round(rss3 / 1024 / 1024),
          growth1to2: Math.round(rssGrowth1to2 / 1024 / 1024),
          growth2to3: Math.round(rssGrowth2to3 / 1024 / 1024),
          totalGrowth: Math.round(totalRssGrowth / 1024 / 1024),
          totalGrowthPercent: Math.round((totalRssGrowth / rss1) * 100 * 100) / 100,
        },
        snapshots: this.results.snapshots.length,
      };

      var heapGrowth = totalHeapGrowth;
      var heapGrowthPercent = (totalHeapGrowth / heap1) * 100;
    } else {
      this.log("Mixed or incompatible snapshot types - cannot analyze memory growth", "warn");
      analysis = {
        error: "Incompatible snapshot types",
        snapshots: this.results.snapshots.length,
        snapshotTypes: this.results.snapshots.map((s) => ({ label: s.label, type: s.type })),
      };
      this.results.memoryAnalysis = analysis;
      return;
    }

    this.results.memoryAnalysis = analysis;

    // Generate recommendations
    const recommendations = [];

    if (Math.abs(heapGrowth) > this.options.memoryLeakThreshold * 1024 * 1024) {
      recommendations.push({
        type: "warning",
        message: `Significant heap growth detected: ${Math.round(
          heapGrowth / 1024 / 1024
        )}MB increase`,
        suggestion: "Consider investigating object retention and event listener cleanup",
      });
    }

    if (Math.abs(heapGrowthPercent) > this.options.heapGrowthThreshold * 100) {
      recommendations.push({
        type: "warning",
        message: `High heap growth percentage: ${heapGrowthPercent.toFixed(1)}%`,
        suggestion: "Review memory allocation patterns and garbage collection behavior",
      });
    }

    if (
      this.results.totalRequests.failed >
      (this.results.totalRequests.phase1 + this.results.totalRequests.phase2) * 0.1
    ) {
      recommendations.push({
        type: "error",
        message: `High request failure rate: ${this.results.totalRequests.failed}/${
          this.results.totalRequests.phase1 + this.results.totalRequests.phase2
        }`,
        suggestion: "Fix failing endpoints before analyzing memory patterns",
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        type: "info",
        message: "No obvious memory leaks detected in this test run",
        suggestion: "Consider running longer tests or testing different API endpoints",
      });
    }

    this.results.recommendations = recommendations;

    // Log analysis results
    this.log("=== Memory Analysis Results ===");

    if (this.results.memoryAnalysis.snapshotAnalysis) {
      const analysis = this.results.memoryAnalysis.snapshotAnalysis;
      this.log(`V8 Heap Snapshot Analysis:`);
      this.log(`  Phase 1 (after warmup): ${analysis.phase1.size}MB`);
      this.log(
        `  Phase 2 (after load test 1): ${analysis.phase2.size}MB (${
          analysis.phase2.growthPercentFromPhase1 > 0 ? "+" : ""
        }${analysis.phase2.growthPercentFromPhase1}%)`
      );
      this.log(
        `  Phase 3 (after load test 2): ${analysis.phase3.size}MB (${
          analysis.phase3.growthPercentFromPhase2 > 0 ? "+" : ""
        }${analysis.phase3.growthPercentFromPhase2}%)`
      );
      this.log(
        `  Total Growth: ${analysis.total.growthPercent > 0 ? "+" : ""}${
          analysis.total.growth
        }MB (${analysis.total.growthPercent}%)`
      );

      this.log(`\nSnapshot files saved:`);
      this.log(`  1. ${analysis.phase1.file}`);
      this.log(`  2. ${analysis.phase2.file}`);
      this.log(`  3. ${analysis.phase3.file}`);
      this.log(`\n💡 Analyze snapshots in Chrome DevTools:`);
      this.log(`  1. Open Chrome DevTools → Memory tab`);
      this.log(`  2. Load all 3 .heapsnapshot files`);
      this.log(`  3. Compare snapshots to identify memory leaks`);
      this.log(`  4. Focus on comparing snapshot 1 vs 3 for overall growth`);
    } else if (this.results.memoryAnalysis.heapUsage) {
      const heap = this.results.memoryAnalysis.heapUsage;
      const rss = this.results.memoryAnalysis.rssUsage;
      this.log(`Heap Usage Analysis:`);
      this.log(`  Phase 1: ${heap.phase1}MB`);
      this.log(
        `  Phase 2: ${heap.phase2}MB (${heap.growth1to2 > 0 ? "+" : ""}${heap.growth1to2}MB)`
      );
      this.log(
        `  Phase 3: ${heap.phase3}MB (${heap.growth2to3 > 0 ? "+" : ""}${heap.growth2to3}MB)`
      );
      this.log(
        `  Total Growth: ${heap.totalGrowthPercent > 0 ? "+" : ""}${heap.totalGrowth}MB (${
          heap.totalGrowthPercent
        }%)`
      );

      this.log(`RSS Usage Analysis:`);
      this.log(`  Phase 1: ${rss.phase1}MB`);
      this.log(`  Phase 2: ${rss.phase2}MB (${rss.growth1to2 > 0 ? "+" : ""}${rss.growth1to2}MB)`);
      this.log(`  Phase 3: ${rss.phase3}MB (${rss.growth2to3 > 0 ? "+" : ""}${rss.growth2to3}MB)`);
      this.log(
        `  Total Growth: ${rss.totalGrowthPercent > 0 ? "+" : ""}${rss.totalGrowth}MB (${
          rss.totalGrowthPercent
        }%)`
      );
    }

    recommendations.forEach((rec, i) => {
      this.log(
        `${i + 1}. [${rec.type.toUpperCase()}] ${rec.message}`,
        rec.type === "error" ? "error" : "info"
      );
      this.log(`   Suggestion: ${rec.suggestion}`, "info");
    });
  }

  async generateReport() {
    const reportData = {
      ...this.results,
      endTime: new Date().toISOString(),
      configuration: {
        serverPort: this.options.serverPort,
        testRequests: this.options.testRequests,
        warmupRequests: this.options.warmupRequests,
        apiEndpoints: this.options.apiEndpoints,
        memoryLeakThreshold: this.options.memoryLeakThreshold,
        heapGrowthThreshold: this.options.heapGrowthThreshold,
        adminToken: this.options.adminToken ? "[REDACTED]" : null,
        runDirectory: this.options.runDir,
      },
    };

    try {
      fs.writeFileSync(this.options.outputFile, JSON.stringify(reportData, null, 2));
      this.log(`Report saved to: ${this.options.outputFile}`);
    } catch (error) {
      this.log(`Failed to save report: ${error.message}`, "error");
    }

    return reportData;
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cleanup() {
    if (this.serverProcess && !this.serverProcess.killed) {
      this.log("Stopping server...");
      this.serverProcess.kill("SIGTERM");

      // Wait a bit for graceful shutdown
      await this.delay(2000);

      if (!this.serverProcess.killed) {
        this.serverProcess.kill("SIGKILL");
      }
    }
  }

  async run() {
    try {
      this.log("=== Memory Leak Detection Started ===");
      this.log(`Run directory: ${this.options.runDir}`);

      await this.ensureSnapshotDir();
      await this.startServer();

      // Wait for server to fully initialize
      await this.delay(3000);

      // Phase 1: Warmup requests + first snapshot
      this.log("\n=== Phase 1: Warmup ===");
      await this.performRequestPhase("warmup", this.options.warmupRequests);

      // Force GC and wait before snapshot
      if (global.gc) {
        global.gc();
        await this.delay(1000);
      }
      await this.takeHeapSnapshot("after-warmup");

      // Phase 2: First load test + second snapshot
      this.log("\n=== Phase 2: Load Test 1 ===");
      await this.performRequestPhase("load-test-1", this.options.testRequests);

      // Force GC and wait before snapshot
      if (global.gc) {
        global.gc();
        await this.delay(1000);
      }
      await this.takeHeapSnapshot("after-load-test-1");

      // Phase 3: Second load test + third snapshot
      this.log("\n=== Phase 3: Load Test 2 ===");
      await this.performRequestPhase("load-test-2", this.options.testRequests);

      // Force GC and wait before final snapshot
      if (global.gc) {
        global.gc();
        await this.delay(2000);
      }
      await this.takeHeapSnapshot("after-load-test-2");

      // Analyze results
      this.analyzeMemoryUsage();

      // Generate report
      await this.generateReport();

      this.log("\n=== Memory Leak Detection Completed ===");
      this.log(`📁 All results saved to: ${this.options.runDir}`);
      this.log(`📊 Report: ${this.options.outputFile}`);
      this.log(`📈 Snapshots: ${this.options.heapSnapshotPath}`);

      if (
        this.results.snapshots.length === 3 &&
        this.results.snapshots[0].type === "v8-heapsnapshot"
      ) {
        this.log(`\n🔍 Next steps:`);
        this.log(`1. Analyze snapshots in Chrome DevTools Memory tab`);
        this.log(`2. Compare snapshot 1 vs 3 to identify memory leaks`);
        this.log(`3. Look for growing Sentry-related objects`);
        this.log(`4. Run with SENTRY_DSN enabled to compare results`);
      }
    } catch (error) {
      this.log(`Detection failed: ${error.message}`, "error");
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

// CLI interface
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i];
    const value = args[i + 1];

    switch (arg) {
      case "--port":
        options.serverPort = parseInt(value);
        break;
      case "--requests":
        options.testRequests = parseInt(value);
        break;
      case "--delay":
        options.requestDelay = parseInt(value);
        break;
      case "--endpoints":
        options.apiEndpoints = value.split(",");
        break;
      case "--threshold":
        options.memoryLeakThreshold = parseFloat(value);
        break;
      case "--output":
        options.outputFile = value;
        break;
      case "--token":
        options.adminToken = value;
        break;
      case "--api-key":
        options.apiKey = value;
        break;
      case "--sentry-dsn":
        options.sentryDsn = value;
        break;
      case "--label":
        options.label = value;
        break;
      case "--verbose":
        options.verbose = true;
        i--; // No value for this flag
        break;
      case "--help":
        console.log(`
Memory Leak Detector Usage:

node memory-leak-detector.js [options]

Options:
  --port <number>        Server port (default: 3030)
  --requests <number>    Number of test requests (default: 100)  
  --delay <ms>          Delay between requests (default: 50)
  --endpoints <list>     Comma-separated API endpoints to test
  --label <string>       Label for the run
  --threshold <MB>       Memory leak threshold in MB (default: 50)
  --token <string>       Admin Bearer token for V8 heap snapshots
  --api-key <string>     API key for API requests
  --sentry-dsn <string>  Sentry DSN for memory leak detection
  --output <file>        Output report file (default: memory-leak-report.json)
  --verbose             Enable verbose logging
  --help                Show this help

Examples:
  node memory-leak-detector.js --verbose --requests 200
  node memory-leak-detector.js --token "your-admin-token" --api-key "your-api-key" --verbose
  node memory-leak-detector.js --endpoints "/api/v1/whoami,/api/v1/projects" --threshold 25
        `);
        process.exit(0);
    }
  }

  return options;
}

// Main execution
if (require.main === module) {
  const options = parseArgs();
  const detector = new MemoryLeakDetector(options);

  detector
    .run()
    .then(() => {
      console.log("\n✅ Memory leak detection completed successfully!");
      console.log(`📁 Results directory: ${detector.options.runDir}`);
      console.log(`📊 Report: ${detector.options.outputFile}`);
      console.log(`📈 Snapshots: ${detector.options.heapSnapshotPath}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Memory leak detection failed:", error.message);
      process.exit(1);
    });
}

module.exports = MemoryLeakDetector;

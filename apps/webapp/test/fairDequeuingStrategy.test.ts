import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FairDequeuingStrategy } from "../app/v3/marqs/fairDequeuingStrategy.server.js";
import {
  calculateStandardDeviation,
  createKeyProducer,
  setupConcurrency,
  setupQueue,
} from "./utils/marqs.js";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("test");

vi.setConfig({ testTimeout: 30_000 }); // 30 seconds timeout

describe("FairDequeuingStrategy", () => {
  redisTest("should distribute a single queue from a single org/env", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 10,
      defaultEnvConcurrency: 5,
      parentQueueLimit: 100,
      checkForDisabledOrgs: true,
      seed: "test-seed-1", // for deterministic shuffling
    });

    // Setup a single queue
    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: Date.now() - 1000, // 1 second ago
      queueId: "queue-1",
      orgId: "org-1",
      envId: "env-1",
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("org:org-1:env:env-1:queue:queue-1");
  });

  redisTest("should respect org concurrency limits", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 2,
      defaultEnvConcurrency: 5,
      parentQueueLimit: 100,
      checkForDisabledOrgs: true,
      seed: "test-seed-2",
    });

    // Setup queue
    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: Date.now() - 1000,
      queueId: "queue-1",
      orgId: "org-1",
      envId: "env-1",
    });

    // Set org-1 to be at its concurrency limit
    await setupConcurrency({
      redis,
      keyProducer,
      org: { id: "org-1", currentConcurrency: 2, limit: 2 },
      env: { id: "env-1", currentConcurrency: 0 },
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");
    expect(result).toHaveLength(0);
  });

  redisTest("should respect env concurrency limits", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 10,
      defaultEnvConcurrency: 2,
      parentQueueLimit: 100,
      checkForDisabledOrgs: true,
      seed: "test-seed-3",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: Date.now() - 1000,
      queueId: "queue-1",
      orgId: "org-1",
      envId: "env-1",
    });

    await setupConcurrency({
      redis,
      keyProducer,
      org: { id: "org-1", currentConcurrency: 0 },
      env: { id: "env-1", currentConcurrency: 2, limit: 2 },
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");
    expect(result).toHaveLength(0);
  });

  redisTest("should handle disabled orgs", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 10,
      defaultEnvConcurrency: 5,
      parentQueueLimit: 100,
      checkForDisabledOrgs: true,
      seed: "test-seed-4",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: Date.now() - 1000,
      queueId: "queue-1",
      orgId: "org-1",
      envId: "env-1",
    });

    await setupConcurrency({
      redis,
      keyProducer,
      org: { id: "org-1", currentConcurrency: 0, isDisabled: true },
      env: { id: "env-1", currentConcurrency: 0 },
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");
    expect(result).toHaveLength(0);
  });

  redisTest("should respect parentQueueLimit", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 10,
      defaultEnvConcurrency: 5,
      parentQueueLimit: 2, // Only take 2 queues
      checkForDisabledOrgs: true,
      seed: "test-seed-6",
    });

    const now = Date.now();

    // Setup 3 queues but parentQueueLimit is 2
    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: now - 3000,
      queueId: "queue-1",
      orgId: "org-1",
      envId: "env-1",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: now - 2000,
      queueId: "queue-2",
      orgId: "org-1",
      envId: "env-1",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: now - 1000,
      queueId: "queue-3",
      orgId: "org-1",
      envId: "env-1",
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");

    expect(result).toHaveLength(2);
    // Should only get the two oldest queues
    const queue1 = keyProducer.queueKey("org-1", "env-1", "queue-1");
    const queue2 = keyProducer.queueKey("org-1", "env-1", "queue-2");
    expect(result).toEqual([queue1, queue2]);
  });

  redisTest("should fairly distribute queues across environments over time", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const strategy = new FairDequeuingStrategy({
      tracer,
      redis,
      keys: keyProducer,
      defaultOrgConcurrency: 10,
      defaultEnvConcurrency: 5,
      parentQueueLimit: 100,
      checkForDisabledOrgs: true,
      seed: "test-seed-5",
    });

    const now = Date.now();

    // Test configuration
    const orgs = ["org-1", "org-2", "org-3"];
    const envsPerOrg = 3; // Each org has 3 environments
    const queuesPerEnv = 5; // Each env has 5 queues
    const iterations = 1000;

    // Setup queues
    for (const orgId of orgs) {
      for (let envNum = 1; envNum <= envsPerOrg; envNum++) {
        const envId = `env-${orgId}-${envNum}`;

        for (let queueNum = 1; queueNum <= queuesPerEnv; queueNum++) {
          await setupQueue({
            redis,
            keyProducer,
            parentQueue: "parent-queue",
            // Vary the ages slightly
            score: now - Math.random() * 10000,
            queueId: `queue-${orgId}-${envId}-${queueNum}`,
            orgId,
            envId,
          });
        }

        // Setup reasonable concurrency limits
        await setupConcurrency({
          redis,
          keyProducer,
          org: { id: orgId, currentConcurrency: 2, limit: 10 },
          env: { id: envId, currentConcurrency: 1, limit: 5 },
        });
      }
    }

    // Track distribution statistics
    type PositionStats = {
      firstPosition: number; // Count of times this env/org was first
      positionSums: number; // Sum of positions (for averaging)
      appearances: number; // Total number of appearances
    };

    const envStats: Record<string, PositionStats> = {};
    const orgStats: Record<string, PositionStats> = {};

    // Initialize stats objects
    for (const orgId of orgs) {
      orgStats[orgId] = { firstPosition: 0, positionSums: 0, appearances: 0 };
      for (let envNum = 1; envNum <= envsPerOrg; envNum++) {
        const envId = `env-${orgId}-${envNum}`;
        envStats[envId] = { firstPosition: 0, positionSums: 0, appearances: 0 };
      }
    }

    // Run multiple iterations
    for (let i = 0; i < iterations; i++) {
      const result = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        `consumer-${i % 3}` // Simulate 3 different consumers
      );

      // Track positions of queues
      result.forEach((queueId, position) => {
        const orgId = keyProducer.orgIdFromQueue(queueId);
        const envId = keyProducer.envIdFromQueue(queueId);

        // Update org stats
        orgStats[orgId].appearances++;
        orgStats[orgId].positionSums += position;
        if (position === 0) orgStats[orgId].firstPosition++;

        // Update env stats
        envStats[envId].appearances++;
        envStats[envId].positionSums += position;
        if (position === 0) envStats[envId].firstPosition++;
      });
    }

    // Calculate and log statistics
    console.log("\nOrganization Statistics:");
    for (const [orgId, stats] of Object.entries(orgStats)) {
      const avgPosition = stats.positionSums / stats.appearances;
      const firstPositionPercentage = (stats.firstPosition / iterations) * 100;
      console.log(`${orgId}:
      First Position: ${firstPositionPercentage.toFixed(2)}%
      Average Position: ${avgPosition.toFixed(2)}
      Total Appearances: ${stats.appearances}`);
    }

    console.log("\nEnvironment Statistics:");
    for (const [envId, stats] of Object.entries(envStats)) {
      const avgPosition = stats.positionSums / stats.appearances;
      const firstPositionPercentage = (stats.firstPosition / iterations) * 100;
      console.log(`${envId}:
      First Position: ${firstPositionPercentage.toFixed(2)}%
      Average Position: ${avgPosition.toFixed(2)}
      Total Appearances: ${stats.appearances}`);
    }

    // Verify fairness of first position distribution
    const expectedFirstPositionPercentage = 100 / orgs.length;
    const firstPositionStdDevOrgs = calculateStandardDeviation(
      Object.values(orgStats).map((stats) => (stats.firstPosition / iterations) * 100)
    );

    const expectedEnvFirstPositionPercentage = 100 / (orgs.length * envsPerOrg);
    const firstPositionStdDevEnvs = calculateStandardDeviation(
      Object.values(envStats).map((stats) => (stats.firstPosition / iterations) * 100)
    );

    // Assert reasonable fairness for first position
    expect(firstPositionStdDevOrgs).toBeLessThan(5); // Allow 5% standard deviation for orgs
    expect(firstPositionStdDevEnvs).toBeLessThan(5); // Allow 5% standard deviation for envs

    // Verify that each org and env gets a fair chance at first position
    for (const [orgId, stats] of Object.entries(orgStats)) {
      const firstPositionPercentage = (stats.firstPosition / iterations) * 100;
      expect(firstPositionPercentage).toBeGreaterThan(expectedFirstPositionPercentage * 0.7); // Within 30% of expected
      expect(firstPositionPercentage).toBeLessThan(expectedFirstPositionPercentage * 1.3);
    }

    for (const [envId, stats] of Object.entries(envStats)) {
      const firstPositionPercentage = (stats.firstPosition / iterations) * 100;
      expect(firstPositionPercentage).toBeGreaterThan(expectedEnvFirstPositionPercentage * 0.7); // Within 30% of expected
      expect(firstPositionPercentage).toBeLessThan(expectedEnvFirstPositionPercentage * 1.3);
    }

    // Verify average positions are reasonably distributed
    const avgPositionsOrgs = Object.values(orgStats).map(
      (stats) => stats.positionSums / stats.appearances
    );
    const avgPositionsEnvs = Object.values(envStats).map(
      (stats) => stats.positionSums / stats.appearances
    );

    const avgPositionStdDevOrgs = calculateStandardDeviation(avgPositionsOrgs);
    const avgPositionStdDevEnvs = calculateStandardDeviation(avgPositionsEnvs);

    expect(avgPositionStdDevOrgs).toBeLessThan(1); // Average positions should be fairly consistent
    expect(avgPositionStdDevEnvs).toBeLessThan(1);
  });

  redisTest(
    "should shuffle environments while maintaining age order within environments",
    async ({ redis }) => {
      const keyProducer = createKeyProducer("test");
      const strategy = new FairDequeuingStrategy({
        tracer,
        redis,
        keys: keyProducer,
        defaultOrgConcurrency: 10,
        defaultEnvConcurrency: 5,
        parentQueueLimit: 100,
        checkForDisabledOrgs: true,
        seed: "fixed-seed",
      });

      const now = Date.now();

      // Setup three environments, each with two queues of different ages
      await Promise.all([
        // env-1: one old queue (3000ms old) and one new queue (1000ms old)
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 3000,
          queueId: "queue-1-old",
          orgId: "org-1",
          envId: "env-1",
        }),
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 1000,
          queueId: "queue-1-new",
          orgId: "org-1",
          envId: "env-1",
        }),

        // env-2: same pattern
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 3000,
          queueId: "queue-2-old",
          orgId: "org-1",
          envId: "env-2",
        }),
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 1000,
          queueId: "queue-2-new",
          orgId: "org-1",
          envId: "env-2",
        }),
      ]);

      // Setup basic concurrency settings
      await setupConcurrency({
        redis,
        keyProducer,
        org: { id: "org-1", currentConcurrency: 0, limit: 10 },
        env: { id: "env-1", currentConcurrency: 0, limit: 5 },
      });
      await setupConcurrency({
        redis,
        keyProducer,
        org: { id: "org-1", currentConcurrency: 0, limit: 10 },
        env: { id: "env-2", currentConcurrency: 0, limit: 5 },
      });

      const result = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );

      // Group queues by environment
      const queuesByEnv = result.reduce((acc, queueId) => {
        const envId = keyProducer.envIdFromQueue(queueId);
        if (!acc[envId]) {
          acc[envId] = [];
        }
        acc[envId].push(queueId);
        return acc;
      }, {} as Record<string, string[]>);

      // Verify that:
      // 1. We got all queues
      expect(result).toHaveLength(4);

      // 2. Queues are grouped by environment
      for (const envQueues of Object.values(queuesByEnv)) {
        expect(envQueues).toHaveLength(2);

        // 3. Within each environment, older queue comes before newer queue
        const [firstQueue, secondQueue] = envQueues;
        expect(firstQueue).toContain("old");
        expect(secondQueue).toContain("new");
      }
    }
  );

  redisTest(
    "should bias shuffling based on concurrency limits and available capacity",
    async ({ redis }) => {
      const keyProducer = createKeyProducer("test");
      const now = Date.now();

      // Setup three environments with different concurrency settings
      const envSetups = [
        {
          envId: "env-1",
          limit: 100,
          current: 20, // Lots of available capacity
          queueCount: 3,
        },
        {
          envId: "env-2",
          limit: 50,
          current: 40, // Less available capacity
          queueCount: 3,
        },
        {
          envId: "env-3",
          limit: 10,
          current: 5, // Some available capacity
          queueCount: 3,
        },
      ];

      // Setup queues and concurrency for each environment
      for (const setup of envSetups) {
        await setupConcurrency({
          redis,
          keyProducer,
          org: { id: "org-1", currentConcurrency: 0, limit: 200 },
          env: {
            id: setup.envId,
            currentConcurrency: setup.current,
            limit: setup.limit,
          },
        });

        for (let i = 0; i < setup.queueCount; i++) {
          await setupQueue({
            redis,
            keyProducer,
            parentQueue: "parent-queue",
            score: now - 1000 * (i + 1),
            queueId: `queue-${i}`,
            orgId: "org-1",
            envId: setup.envId,
          });
        }
      }

      // Create multiple strategies with different seeds
      const numStrategies = 5;
      const strategies = Array.from(
        { length: numStrategies },
        (_, i) =>
          new FairDequeuingStrategy({
            tracer,
            redis,
            keys: keyProducer,
            defaultOrgConcurrency: 10,
            defaultEnvConcurrency: 5,
            parentQueueLimit: 100,
            checkForDisabledOrgs: true,
            seed: `test-seed-${i}`,
            biases: {
              concurrencyLimitBias: 0.8,
              availableCapacityBias: 0.5,
              queueAgeRandomization: 0.0,
            },
          })
      );

      // Run iterations across all strategies
      const iterationsPerStrategy = 100;
      const allResults: Record<string, number>[] = [];

      for (const strategy of strategies) {
        const firstPositionCounts: Record<string, number> = {};

        for (let i = 0; i < iterationsPerStrategy; i++) {
          const result = await strategy.distributeFairQueuesFromParentQueue(
            "parent-queue",
            `consumer-${i % 3}`
          );

          expect(result.length).toBeGreaterThan(0);

          const firstEnv = keyProducer.envIdFromQueue(result[0]);
          firstPositionCounts[firstEnv] = (firstPositionCounts[firstEnv] || 0) + 1;
        }

        allResults.push(firstPositionCounts);
      }

      // Calculate average distributions across all strategies
      const avgDistribution: Record<string, number> = {};
      const envIds = ["env-1", "env-2", "env-3"];

      for (const envId of envIds) {
        const sum = allResults.reduce((acc, result) => acc + (result[envId] || 0), 0);
        avgDistribution[envId] = sum / numStrategies;
      }

      // Log individual strategy results and the average
      console.log("\nResults by strategy:");
      allResults.forEach((result, i) => {
        console.log(`Strategy ${i + 1}:`, result);
      });

      console.log("\nAverage distribution:", avgDistribution);

      // Calculate percentages from average distribution
      const totalCount = Object.values(avgDistribution).reduce((sum, count) => sum + count, 0);
      const highLimitPercentage = (avgDistribution["env-1"] / totalCount) * 100;
      const lowLimitPercentage = (avgDistribution["env-3"] / totalCount) * 100;

      console.log("\nPercentages:");
      console.log("High limit percentage:", highLimitPercentage);
      console.log("Low limit percentage:", lowLimitPercentage);

      // Verify distribution across all strategies
      expect(highLimitPercentage).toBeLessThan(60);
      expect(lowLimitPercentage).toBeGreaterThan(10);
      expect(highLimitPercentage).toBeGreaterThan(lowLimitPercentage);
    }
  );

  redisTest("should respect ageInfluence parameter for queue ordering", async ({ redis }) => {
    const keyProducer = createKeyProducer("test");
    const now = Date.now();

    // Setup queues with different ages in the same environment
    const queueAges = [
      { id: "queue-1", age: 5000 }, // oldest
      { id: "queue-2", age: 3000 },
      { id: "queue-3", age: 1000 }, // newest
    ];

    // Helper function to run iterations with a specific age influence
    async function runWithQueueAgeRandomization(queueAgeRandomization: number) {
      const strategy = new FairDequeuingStrategy({
        tracer,
        redis,
        keys: keyProducer,
        defaultOrgConcurrency: 10,
        defaultEnvConcurrency: 5,
        parentQueueLimit: 100,
        checkForDisabledOrgs: true,
        seed: "fixed-seed",
        biases: {
          concurrencyLimitBias: 0,
          availableCapacityBias: 0,
          queueAgeRandomization,
        },
      });

      const positionCounts: Record<string, number[]> = {
        "queue-1": [0, 0, 0],
        "queue-2": [0, 0, 0],
        "queue-3": [0, 0, 0],
      };

      const iterations = 1000;
      for (let i = 0; i < iterations; i++) {
        const result = await strategy.distributeFairQueuesFromParentQueue(
          "parent-queue",
          "consumer-1"
        );

        result.forEach((queueId, position) => {
          const baseQueueId = queueId.split(":").pop()!;
          positionCounts[baseQueueId][position]++;
        });
      }

      return positionCounts;
    }

    // Setup test data
    for (const { id, age } of queueAges) {
      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - age,
        queueId: id,
        orgId: "org-1",
        envId: "env-1",
      });
    }

    await setupConcurrency({
      redis,
      keyProducer,
      org: { id: "org-1", currentConcurrency: 0, limit: 10 },
      env: { id: "env-1", currentConcurrency: 0, limit: 5 },
    });

    // Test with different age influence values
    const strictAge = await runWithQueueAgeRandomization(0); // Strict age-based ordering
    const mixed = await runWithQueueAgeRandomization(0.5); // Mix of age and random
    const fullyRandom = await runWithQueueAgeRandomization(1); // Completely random

    console.log("Distribution with strict age ordering (0.0):", strictAge);
    console.log("Distribution with mixed ordering (0.5):", mixed);
    console.log("Distribution with random ordering (1.0):", fullyRandom);

    // With strict age ordering (0.0), oldest should always be first
    expect(strictAge["queue-1"][0]).toBe(1000); // Always in first position
    expect(strictAge["queue-3"][0]).toBe(0); // Never in first position

    // With fully random (1.0), positions should still allow for some age bias
    const randomFirstPositionSpread = Math.abs(
      fullyRandom["queue-1"][0] - fullyRandom["queue-3"][0]
    );
    expect(randomFirstPositionSpread).toBeLessThan(200); // Allow for larger spread in distribution

    // With mixed (0.5), should show preference for age but not absolute
    expect(mixed["queue-1"][0]).toBeGreaterThan(mixed["queue-3"][0]); // Older preferred
    expect(mixed["queue-3"][0]).toBeGreaterThan(0); // But newer still gets chances
  });
});

import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { RUN_QUEUE_RESUME_PRIORITY_TIMESTAMP_OFFSET } from "../constants.js";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { EnvQueues, RunQueueKeyProducer } from "../types.js";
import { createRedisClient, RedisOptions } from "@internal/redis";

vi.setConfig({ testTimeout: 60_000 }); // 30 seconds timeout

describe("FairDequeuingStrategy", () => {
  redisTest(
    "should distribute a single queue from a single env",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
        seed: "test-seed-1", // for deterministic shuffling
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: Date.now() - 1000, // 1 second ago
        queueId: "queue-1",
        orgId: "org-1",
        projectId: "proj-1",
        envId: "env-1",
      });

      const result = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        envId: "env-1",
        queues: [keyProducer.queueKey("org-1", "proj-1", "env-1", "queue-1")],
      });
    }
  );

  redisTest("should respect env concurrency limits", async ({ redisOptions: redis }) => {
    const keyProducer = new RunQueueFullKeyProducer();
    const strategy = new FairQueueSelectionStrategy({
      redis,
      keys: keyProducer,
      defaultEnvConcurrencyLimit: 2,
      parentQueueLimit: 100,
      seed: "test-seed-3",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: Date.now() - 1000,
      queueId: "queue-1",
      orgId: "org-1",
      projectId: "proj-1",
      envId: "env-1",
    });

    await setupConcurrency({
      redis,
      keyProducer,
      env: { envId: "env-1", projectId: "proj-1", orgId: "org-1", currentConcurrency: 2, limit: 2 },
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");
    expect(result).toHaveLength(0);
  });

  redisTest("should respect parentQueueLimit", async ({ redisOptions: redis }) => {
    const keyProducer = new RunQueueFullKeyProducer();
    const strategy = new FairQueueSelectionStrategy({
      redis,
      keys: keyProducer,
      defaultEnvConcurrencyLimit: 5,
      parentQueueLimit: 2, // Only take 2 queues
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
      projectId: "proj-1",
      envId: "env-1",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: now - 2000,
      queueId: "queue-2",
      orgId: "org-1",
      projectId: "proj-1",
      envId: "env-1",
    });

    await setupQueue({
      redis,
      keyProducer,
      parentQueue: "parent-queue",
      score: now - 1000,
      queueId: "queue-3",
      orgId: "org-1",
      projectId: "proj-1",
      envId: "env-1",
    });

    const result = await strategy.distributeFairQueuesFromParentQueue("parent-queue", "consumer-1");

    expect(result).toHaveLength(1);
    const queue1 = keyProducer.queueKey("org-1", "proj-1", "env-1", "queue-1");
    const queue2 = keyProducer.queueKey("org-1", "proj-1", "env-1", "queue-2");
    expect(result[0]).toEqual({
      envId: "env-1",
      queues: [queue1, queue2],
    });
  });

  redisTest(
    "should reuse snapshots across calls for the same consumer",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 10,
        seed: "test-seed-reuse-1",
        reuseSnapshotCount: 1,
      });

      const now = Date.now();

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 3000,
        queueId: "queue-1",
        orgId: "org-1",
        projectId: "proj-1",
        envId: "env-1",
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 2000,
        queueId: "queue-2",
        orgId: "org-2",
        projectId: "proj-2",
        envId: "env-2",
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 1000,
        queueId: "queue-3",
        orgId: "org-3",
        projectId: "proj-3",
        envId: "env-3",
      });

      const startDistribute1 = performance.now();

      const envResult = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );
      const result = flattenResults(envResult);

      const distribute1Duration = performance.now() - startDistribute1;

      console.log("First distribution took", distribute1Duration, "ms");

      expect(result).toHaveLength(3);
      // Should only get the two oldest queues
      const queue1 = keyProducer.queueKey("org-1", "proj-1", "env-1", "queue-1");
      const queue2 = keyProducer.queueKey("org-2", "proj-2", "env-2", "queue-2");
      const queue3 = keyProducer.queueKey("org-3", "proj-3", "env-3", "queue-3");
      expect(result).toEqual([queue2, queue1, queue3]);

      const startDistribute2 = performance.now();

      const result2 = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );

      const distribute2Duration = performance.now() - startDistribute2;

      console.log("Second distribution took", distribute2Duration, "ms");

      // Make sure the second call is more than 2 times faster than the first
      expect(distribute2Duration).toBeLessThan(distribute1Duration / 2);

      const startDistribute3 = performance.now();

      const result3 = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );

      const distribute3Duration = performance.now() - startDistribute3;

      console.log("Third distribution took", distribute3Duration, "ms");

      // Make sure the third call is more than 4 times the second
      expect(distribute3Duration).toBeGreaterThan(distribute2Duration * 2);
    }
  );

  redisTest(
    "should fairly distribute queues across environments over time",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
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
          const projectId = `proj-${orgId}-${envNum}`;

          for (let queueNum = 1; queueNum <= queuesPerEnv; queueNum++) {
            await setupQueue({
              redis,
              keyProducer,
              parentQueue: "parent-queue",
              // Vary the ages slightly
              score: now - Math.random() * 10000,
              queueId: `queue-${orgId}-${envId}-${queueNum}`,
              orgId,
              projectId,
              envId,
            });
          }

          // Setup reasonable concurrency limits
          await setupConcurrency({
            redis,
            keyProducer,
            env: { envId, projectId, orgId, currentConcurrency: 1, limit: 5 },
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
        const envResult = await strategy.distributeFairQueuesFromParentQueue(
          "parent-queue",
          `consumer-${i % 3}` // Simulate 3 different consumers
        );
        const result = flattenResults(envResult);

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
    }
  );

  redisTest(
    "should shuffle environments while maintaining age order within environments",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
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
          projectId: "proj-1",
          envId: "env-1",
        }),
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 1000,
          queueId: "queue-1-new",
          orgId: "org-1",
          projectId: "proj-1",
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
          projectId: "proj-1",
          envId: "env-2",
        }),
        setupQueue({
          redis,
          keyProducer,
          parentQueue: "parent-queue",
          score: now - 1000,
          queueId: "queue-2-new",
          orgId: "org-1",
          projectId: "proj-1",
          envId: "env-2",
        }),
      ]);

      // Setup basic concurrency settings
      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-1",
          projectId: "proj-1",
          orgId: "org-1",
          currentConcurrency: 0,
          limit: 5,
        },
      });
      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-2",
          projectId: "proj-1",
          orgId: "org-1",
          currentConcurrency: 0,
          limit: 5,
        },
      });

      const envResult = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );
      const result = flattenResults(envResult);

      // Group queues by environment
      const queuesByEnv = result.reduce(
        (acc, queueId) => {
          const envId = keyProducer.envIdFromQueue(queueId);
          if (!acc[envId]) {
            acc[envId] = [];
          }
          acc[envId].push(queueId);
          return acc;
        },
        {} as Record<string, string[]>
      );

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
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const now = Date.now();

      // Setup three environments with different concurrency settings
      const envSetups = [
        {
          envId: "env-1",
          orgId: "org-1",
          projectId: "proj-1",
          limit: 100,
          current: 20, // Lots of available capacity
          queueCount: 3,
        },
        {
          envId: "env-2",
          orgId: "org-1",
          projectId: "proj-1",
          limit: 50,
          current: 40, // Less available capacity
          queueCount: 3,
        },
        {
          envId: "env-3",
          orgId: "org-1",
          projectId: "proj-1",
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
          env: {
            envId: setup.envId,
            projectId: setup.projectId,
            orgId: setup.orgId,
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
            projectId: "proj-1",
            envId: setup.envId,
          });
        }
      }

      // Create multiple strategies with different seeds
      const numStrategies = 5;
      const strategies = Array.from(
        { length: numStrategies },
        (_, i) =>
          new FairQueueSelectionStrategy({
            redis,
            keys: keyProducer,
            defaultEnvConcurrencyLimit: 5,
            parentQueueLimit: 100,
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
          const envResult = await strategy.distributeFairQueuesFromParentQueue(
            "parent-queue",
            `consumer-${i % 3}`
          );
          const result = flattenResults(envResult);

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

  redisTest(
    "should respect ageInfluence parameter for queue ordering",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const now = Date.now();

      // Setup queues with different ages in the same environment
      const queueAges = [
        { id: "queue-1", age: 5000 }, // oldest
        { id: "queue-2", age: 3000 },
        { id: "queue-3", age: 1000 }, // newest
      ];

      // Helper function to run iterations with a specific age influence
      async function runWithQueueAgeRandomization(queueAgeRandomization: number) {
        const strategy = new FairQueueSelectionStrategy({
          redis,
          keys: keyProducer,
          defaultEnvConcurrencyLimit: 5,
          parentQueueLimit: 100,
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
          const envResult = await strategy.distributeFairQueuesFromParentQueue(
            "parent-queue",
            "consumer-1"
          );
          const result = flattenResults(envResult);

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
          projectId: "proj-1",
          envId: "env-1",
        });
      }

      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-1",
          projectId: "proj-1",
          orgId: "org-1",
          currentConcurrency: 0,
          limit: 5,
        },
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
    }
  );

  redisTest(
    "should respect maximumEnvCount and select envs based on queue ages",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
        seed: "test-seed-max-orgs",
        maximumEnvCount: 2, // Only select top 2 orgs
      });

      const now = Date.now();

      // Setup 4 envs with different queue age profiles
      const envSetups = [
        {
          envId: "env-1",
          orgId: "org-1",
          projectId: "proj-1",
          queues: [
            { age: 1000 }, // Average age: 1000
          ],
        },
        {
          envId: "env-2",
          orgId: "org-1",
          projectId: "proj-1",
          queues: [
            { age: 5000 }, // Average age: 5000
            { age: 5000 },
          ],
        },
        {
          envId: "env-3",
          orgId: "org-1",
          projectId: "proj-1",
          queues: [
            { age: 2000 }, // Average age: 2000
            { age: 2000 },
          ],
        },
        {
          envId: "env-4",
          orgId: "org-1",
          projectId: "proj-1",
          queues: [
            { age: 500 }, // Average age: 500
            { age: 500 },
          ],
        },
      ];

      // Setup queues and concurrency for each org
      for (const setup of envSetups) {
        await setupConcurrency({
          redis,
          keyProducer,
          env: {
            envId: setup.envId,
            projectId: setup.projectId,
            orgId: setup.orgId,
            currentConcurrency: 0,
            limit: 5,
          },
        });

        for (let i = 0; i < setup.queues.length; i++) {
          await setupQueue({
            redis,
            keyProducer,
            parentQueue: "parent-queue",
            score: now - setup.queues[i].age,
            queueId: `queue-${setup.envId}-${i}`,
            orgId: `org-${setup.envId}`,
            projectId: `proj-${setup.envId}`,
            envId: setup.envId,
          });
        }
      }

      // Run multiple iterations to verify consistent behavior
      const iterations = 100;
      const selectedEnvCounts: Record<string, number> = {};

      for (let i = 0; i < iterations; i++) {
        const envResult = await strategy.distributeFairQueuesFromParentQueue(
          "parent-queue",
          `consumer-${i}`
        );
        const result = flattenResults(envResult);

        // Track which orgs were included in the result
        const selectedEnvs = new Set(result.map((queueId) => keyProducer.envIdFromQueue(queueId)));

        // Verify we never get more than maximumOrgCount orgs
        expect(selectedEnvs.size).toBeLessThanOrEqual(2);

        for (const envId of selectedEnvs) {
          selectedEnvCounts[envId] = (selectedEnvCounts[envId] || 0) + 1;
        }
      }

      console.log("Environment selection counts:", selectedEnvCounts);

      // org-2 should be selected most often (highest average age)
      expect(selectedEnvCounts["env-2"]).toBeGreaterThan(selectedEnvCounts["env-4"] || 0);

      // org-4 should be selected least often (lowest average age)
      const env4Count = selectedEnvCounts["env-4"] || 0;
      expect(env4Count).toBeLessThan(selectedEnvCounts["env-2"]);

      // Verify that envs with higher average queue age are selected more frequently
      const sortedEnvs = Object.entries(selectedEnvCounts).sort((a, b) => b[1] - a[1]);
      console.log("Sorted environment frequencies:", sortedEnvs);

      // The top 2 most frequently selected orgs should be env-2 and env-3
      // as they have the highest average queue ages
      const topTwoEnvs = new Set([sortedEnvs[0][0], sortedEnvs[1][0]]);
      expect(topTwoEnvs).toContain("env-2"); // Highest average age
      expect(topTwoEnvs).toContain("env-3"); // Second highest average age

      // Calculate selection percentages
      const totalSelections = Object.values(selectedEnvCounts).reduce((a, b) => a + b, 0);
      const selectionPercentages = Object.entries(selectedEnvCounts).reduce(
        (acc, [orgId, count]) => {
          acc[orgId] = (count / totalSelections) * 100;
          return acc;
        },
        {} as Record<string, number>
      );

      console.log("Environment selection percentages:", selectionPercentages);

      // Verify that env-2 (highest average age) gets selected in at least 40% of iterations
      expect(selectionPercentages["env-2"]).toBeGreaterThan(40);

      // Verify that env-4 (lowest average age) gets selected in less than 20% of iterations
      expect(selectionPercentages["env-4"] || 0).toBeLessThan(20);
    }
  );

  redisTest(
    "should not overly bias picking environments when queue have priority offset ages",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
        seed: "test-seed-max-orgs",
        maximumEnvCount: 2, // Only select top 2 orgs
      });

      const now = Date.now();

      // Setup 4 envs with different queue age profiles
      const envSetups = [
        {
          envId: "env-1",
          queues: [
            { age: 1000 }, // Average age: 1000
          ],
        },
        {
          envId: "env-2",
          queues: [
            { age: 5000 + RUN_QUEUE_RESUME_PRIORITY_TIMESTAMP_OFFSET }, // Average age: 5000 + 1 year
            { age: 5000 + RUN_QUEUE_RESUME_PRIORITY_TIMESTAMP_OFFSET },
          ],
        },
        {
          envId: "env-3",
          queues: [
            { age: 2000 }, // Average age: 2000
            { age: 2000 },
          ],
        },
        {
          envId: "env-4",
          queues: [
            { age: 500 }, // Average age: 500
            { age: 500 },
          ],
        },
      ];

      // Setup queues and concurrency for each org
      for (const setup of envSetups) {
        await setupConcurrency({
          redis,
          keyProducer,
          env: {
            envId: setup.envId,
            projectId: "proj-1",
            orgId: "org-1",
            currentConcurrency: 0,
            limit: 5,
          },
        });

        for (let i = 0; i < setup.queues.length; i++) {
          await setupQueue({
            redis,
            keyProducer,
            parentQueue: "parent-queue",
            score: now - setup.queues[i].age,
            queueId: `queue-${setup.envId}-${i}`,
            orgId: `org-${setup.envId}`,
            projectId: `proj-${setup.envId}`,
            envId: setup.envId,
          });
        }
      }

      // Run multiple iterations to verify consistent behavior
      const iterations = 100;
      const selectedEnvCounts: Record<string, number> = {};

      for (let i = 0; i < iterations; i++) {
        const envResult = await strategy.distributeFairQueuesFromParentQueue(
          "parent-queue",
          `consumer-${i}`
        );
        const result = flattenResults(envResult);

        // Track which orgs were included in the result
        const selectedEnvs = new Set(result.map((queueId) => keyProducer.envIdFromQueue(queueId)));

        // Verify we never get more than maximumOrgCount orgs
        expect(selectedEnvs.size).toBeLessThanOrEqual(2);

        for (const envId of selectedEnvs) {
          selectedEnvCounts[envId] = (selectedEnvCounts[envId] || 0) + 1;
        }
      }

      console.log("Environment selection counts:", selectedEnvCounts);

      // org-2 should be selected most often (highest average age)
      expect(selectedEnvCounts["env-2"]).toBeGreaterThan(selectedEnvCounts["env-4"] || 0);

      // org-4 should be selected least often (lowest average age)
      const env4Count = selectedEnvCounts["env-4"] || 0;
      expect(env4Count).toBeLessThan(selectedEnvCounts["env-2"]);

      // Verify that envs with higher average queue age are selected more frequently
      const sortedEnvs = Object.entries(selectedEnvCounts).sort((a, b) => b[1] - a[1]);
      console.log("Sorted environment frequencies:", sortedEnvs);

      // The top 2 most frequently selected orgs should be env-2 and env-3
      // as they have the highest average queue ages
      const topTwoEnvs = new Set([sortedEnvs[0][0], sortedEnvs[1][0]]);
      expect(topTwoEnvs).toContain("env-2"); // Highest average age
      expect(topTwoEnvs).toContain("env-3"); // Second highest average age

      // Calculate selection percentages
      const totalSelections = Object.values(selectedEnvCounts).reduce((a, b) => a + b, 0);
      const selectionPercentages = Object.entries(selectedEnvCounts).reduce(
        (acc, [orgId, count]) => {
          acc[orgId] = (count / totalSelections) * 100;
          return acc;
        },
        {} as Record<string, number>
      );

      console.log("Environment selection percentages:", selectionPercentages);

      // Verify that env-2 (highest average age) gets selected in at least 40% of iterations
      expect(selectionPercentages["env-2"]).toBeGreaterThan(40);

      // Verify that env-4 (lowest average age) gets selected in less than 20% of iterations
    expect(selectionPercentages["env-4"] || 0).toBeLessThan(20);
    }
  );

  redisTest(
    "#selectTopEnvs groups queues by environment",
    async ({ redisOptions: redis }) => {
      const keyProducer = new RunQueueFullKeyProducer();
      const strategy = new FairQueueSelectionStrategy({
        redis,
        keys: keyProducer,
        defaultEnvConcurrencyLimit: 5,
        parentQueueLimit: 100,
        seed: "group-test",
        maximumEnvCount: 2,
      });

      const now = Date.now();

      // env-1 with two queues from different orgs/projects
      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 1000,
        queueId: "queue-1-old",
        orgId: "org-a",
        projectId: "proj-a",
        envId: "env-1",
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 10,
        queueId: "queue-1-new",
        orgId: "org-b",
        projectId: "proj-b",
        envId: "env-1",
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 400,
        queueId: "queue-2",
        orgId: "org-2",
        projectId: "proj-2",
        envId: "env-2",
      });

      await setupQueue({
        redis,
        keyProducer,
        parentQueue: "parent-queue",
        score: now - 300,
        queueId: "queue-3",
        orgId: "org-3",
        projectId: "proj-3",
        envId: "env-3",
      });

      // Setup concurrency limits
      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-1",
          projectId: "proj-a",
          orgId: "org-a",
          currentConcurrency: 0,
          limit: 5,
        },
      });

      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-1",
          projectId: "proj-b",
          orgId: "org-b",
          currentConcurrency: 0,
          limit: 5,
        },
      });

      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-2",
          projectId: "proj-2",
          orgId: "org-2",
          currentConcurrency: 0,
          limit: 5,
        },
      });

      await setupConcurrency({
        redis,
        keyProducer,
        env: {
          envId: "env-3",
          projectId: "proj-3",
          orgId: "org-3",
          currentConcurrency: 0,
          limit: 5,
        },
      });

      const envResult = await strategy.distributeFairQueuesFromParentQueue(
        "parent-queue",
        "consumer-1"
      );

      const result = flattenResults(envResult);

      const queuesByEnv = result.reduce(
        (acc, queueId) => {
          const envId = keyProducer.envIdFromQueue(queueId);
          if (!acc[envId]) {
            acc[envId] = [];
          }
          acc[envId].push(queueId);
          return acc;
        },
        {} as Record<string, string[]>
      );

      expect(Object.keys(queuesByEnv).length).toBe(2);
      expect(queuesByEnv["env-1"]).toBeDefined();
      expect(queuesByEnv["env-1"].length).toBe(2);
    }
  );
});

// Helper function to flatten results for counting
function flattenResults(results: Array<EnvQueues>): string[] {
  return results.flatMap((envQueue) => envQueue.queues);
}

type SetupQueueOptions = {
  parentQueue: string;
  redis: RedisOptions;
  score: number;
  queueId: string;
  orgId: string;
  projectId: string;
  envId: string;
  keyProducer: RunQueueKeyProducer;
};

/**
 * Adds a queue to Redis with the given parameters
 */
async function setupQueue({
  redis,
  keyProducer,
  parentQueue,
  score,
  queueId,
  orgId,
  projectId,
  envId,
}: SetupQueueOptions) {
  const $redis = createRedisClient(redis);
  // Add the queue to the parent queue's sorted set
  const queue = keyProducer.queueKey(orgId, projectId, envId, queueId);

  await $redis.zadd(parentQueue, score, queue);
}

type SetupConcurrencyOptions = {
  redis: RedisOptions;
  keyProducer: RunQueueKeyProducer;
  env: {
    envId: string;
    projectId: string;
    orgId: string;
    currentConcurrency: number;
    limit?: number;
  };
};

/**
 * Sets up concurrency-related Redis keys for orgs and envs
 */
async function setupConcurrency({ redis, keyProducer, env }: SetupConcurrencyOptions) {
  const $redis = createRedisClient(redis);
  // Set env concurrency limit
  if (typeof env.limit === "number") {
    await $redis.set(keyProducer.envConcurrencyLimitKey(env), env.limit.toString());
  }

  if (env.currentConcurrency > 0) {
    // Set current concurrency by adding dummy members to the set
    const envCurrentKey = keyProducer.envCurrentConcurrencyKey(env);

    // Add dummy running job IDs to simulate current concurrency
    const dummyJobs = Array.from(
      { length: env.currentConcurrency },
      (_, i) => `dummy-job-${i}-${Date.now()}`
    );

    await $redis.sadd(envCurrentKey, ...dummyJobs);
  }
}

/**
 * Calculates the standard deviation of a set of numbers.
 * Standard deviation measures the amount of variation of a set of values from their mean.
 * A low standard deviation indicates that the values tend to be close to the mean.
 *
 * @param values Array of numbers to calculate standard deviation for
 * @returns The standard deviation of the values
 */
function calculateStandardDeviation(values: number[]): number {
  // If there are no values or only one value, the standard deviation is 0
  if (values.length <= 1) {
    return 0;
  }

  // Calculate the mean (average) of the values
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

  // Calculate the sum of squared differences from the mean
  const squaredDifferences = values.map((value) => Math.pow(value - mean, 2));
  const sumOfSquaredDifferences = squaredDifferences.reduce((sum, value) => sum + value, 0);

  // Calculate the variance (average of squared differences)
  const variance = sumOfSquaredDifferences / (values.length - 1); // Using n-1 for sample standard deviation

  // Standard deviation is the square root of the variance
  return Math.sqrt(variance);
}

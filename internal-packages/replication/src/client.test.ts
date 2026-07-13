import { postgresAndRedisTest } from "@internal/testcontainers";
import { LogicalReplicationClient } from "./client.js";
import { setTimeout } from "timers/promises";

describe("Replication Client", () => {
  postgresAndRedisTest(
    "should be able to subscribe to changes on a table",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const client = new LogicalReplicationClient({
        name: "test",
        slotName: "test_slot",
        publicationName: "test_publication",
        redisOptions,
        table: "TaskRun",
        pgConfig: {
          connectionString: postgresContainer.getConnectionUri(),
        },
      });

      const logs: Array<{
        lsn: string;
        log: unknown;
      }> = [];

      client.events.on("data", (data) => {
        console.log(data);
        logs.push(data);
      });

      client.events.on("error", (error) => {
        console.error(error);
      });

      await client.subscribe();

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // Now we insert a row into the table
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
        },
      });

      // Wait for a bit of time
      await setTimeout(50);

      // Now we should see the row in the logs
      expect(logs.length).toBeGreaterThan(0);

      await client.stop();
    }
  );

  postgresAndRedisTest(
    "should be able to teardown",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const client = new LogicalReplicationClient({
        name: "test",
        slotName: "test_slot",
        publicationName: "test_publication",
        redisOptions,
        table: "TaskRun",
        pgConfig: {
          connectionString: postgresContainer.getConnectionUri(),
        },
      });

      const logs: Array<{
        lsn: string;
        log: unknown;
      }> = [];

      client.events.on("data", (data) => {
        console.log(data);
        logs.push(data);
      });

      client.events.on("error", (error) => {
        console.error(error);
      });

      await client.subscribe();

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // Now we insert a row into the table
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
        },
      });

      // Wait for a bit of time
      await setTimeout(50);

      // Now we should see the row in the logs
      expect(logs.length).toBeGreaterThan(0);

      const slotDropped = await client.teardown();

      expect(slotDropped).toBe(true);

      // Now the replication slot should be gone
      const slotExists = await prisma.$queryRaw<
        { exists: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'test_slot');`;

      console.log(slotExists);

      expect(slotExists[0].exists).toBe(false);
    }
  );

  postgresAndRedisTest(
    "two clients on the same slot must not both lead (rolling-deploy handoff)",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "handoff_slot",
        publicationName: "handoff_publication",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      // Leader on the shared slot.
      const a = new LogicalReplicationClient({ ...shared, name: "runs-replication" });
      const aElections: boolean[] = [];
      a.events.on("leaderElection", (won) => aElections.push(won));
      a.events.on("error", () => {});
      await a.subscribe();
      // Let A's walsender actually attach to the slot before B races it.
      await setTimeout(1000);

      // Second client, SAME slot, DIFFERENT name — the rolling-deploy shape that
      // regressed (name changed "runs-replication" -> "runs-replication:legacy").
      const b = new LogicalReplicationClient({
        ...shared,
        name: "runs-replication:legacy",
        leaderLockTimeoutMs: 1000,
        leaderLockAcquireAdditionalTimeMs: 250,
        leaderLockRetryIntervalMs: 200,
      });
      const bElections: boolean[] = [];
      const bErrors: Array<unknown> = [];
      b.events.on("leaderElection", (won) => bElections.push(won));
      b.events.on("error", (error) => bErrors.push(error));
      await b.subscribe();
      await setTimeout(500);

      expect(aElections).toContain(true);
      // B must not also win leadership on the same slot, nor race START_REPLICATION
      // into a "slot is active" error. With a name-keyed lock it did both.
      expect(bElections).not.toContain(true);
      expect(bElections).toContain(false);
      expect(
        bErrors
          .map((e) => String((e as Error)?.message ?? e))
          .some((m) => /replication slot .* is active|already active/i.test(m))
      ).toBe(false);

      await a.stop();
      await b.stop();
    }
  );

  postgresAndRedisTest(
    "resubscribeOnFailure self-heals once the leader releases the slot",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "resub_slot",
        publicationName: "resub_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      // Leader holds the slot.
      const a = new LogicalReplicationClient({ ...shared, name: "leader-a" });
      a.events.on("error", () => {});
      await a.subscribe();
      await setTimeout(1000);

      // Contender with resubscribe on: loses the election while A holds the slot,
      // then must self-heal (win) once A releases it — the rolling-deploy handoff.
      const b = new LogicalReplicationClient({
        ...shared,
        name: "contender-b",
        resubscribeOnFailure: true,
        resubscribeMinDelayMs: 200,
        resubscribeMaxDelayMs: 400,
        leaderLockTimeoutMs: 500,
        leaderLockAcquireAdditionalTimeMs: 100,
        leaderLockRetryIntervalMs: 100,
      });
      const bElections: boolean[] = [];
      b.events.on("leaderElection", (won) => bElections.push(won));
      b.events.on("error", () => {});
      await b.subscribe();
      await setTimeout(1500);

      // Still contending, not leader, while A holds the slot.
      expect(bElections).toContain(false);
      expect(bElections).not.toContain(true);

      // Release the leader — a scheduled resubscribe should now win.
      await a.shutdown();

      let becameLeader = false;
      for (let i = 0; i < 40; i++) {
        if (bElections.includes(true)) {
          becameLeader = true;
          break;
        }
        await setTimeout(250);
      }
      expect(becameLeader).toBe(true);

      await b.shutdown();
    }
  );

  postgresAndRedisTest(
    "a failing START_REPLICATION retry loop must not leak connections or locks",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "leak_slot",
        publicationName: "leak_pub",
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      const a = new LogicalReplicationClient({ ...shared, redisOptions, name: "leak-leader" });
      a.events.on("error", () => {});
      await a.subscribe();
      await setTimeout(1000);

      // B elects on a separate lock namespace so every attempt reaches
      // START_REPLICATION and dies there ("slot is active") — the stuck-slot shape.
      const b = new LogicalReplicationClient({
        ...shared,
        redisOptions: { ...redisOptions, keyPrefix: `${redisOptions.keyPrefix ?? ""}other:` },
        name: "leak-contender",
        resubscribeOnFailure: true,
        resubscribeMinDelayMs: 200,
        resubscribeMaxDelayMs: 400,
        leaderLockTimeoutMs: 1000,
        leaderLockAcquireAdditionalTimeMs: 300,
        leaderLockRetryIntervalMs: 100,
      });
      const bErrors: Array<unknown> = [];
      b.events.on("error", (error) => bErrors.push(error));
      await b.subscribe();

      for (let i = 0; i < 80 && bErrors.length < 3; i++) {
        await setTimeout(250);
      }
      expect(bErrors.length).toBeGreaterThanOrEqual(3);

      // Every failed attempt must end its pg client: at most the one in-flight
      // attempt's backend may exist, never an accrual across cycles.
      const backends = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = 'leak-contender'
      `;
      expect(Number(backends[0].count)).toBeLessThanOrEqual(1);

      const active = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_replication_slots WHERE slot_name = 'leak_slot' AND active
      `;
      expect(Number(active[0].count)).toBe(1);

      await b.shutdown();
      await a.shutdown();
    }
  );

  postgresAndRedisTest(
    "shutdown during an in-flight subscribe must not leave a zombie leader",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "zombie_slot",
        publicationName: "zombie_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      const a = new LogicalReplicationClient({ ...shared, name: "zombie-leader" });
      a.events.on("error", () => {});
      await a.subscribe();
      await setTimeout(1000);

      // B's election spins against A's held lock; shut it down mid-subscribe.
      const b = new LogicalReplicationClient({
        ...shared,
        name: "zombie-contender",
        resubscribeOnFailure: true,
        leaderLockTimeoutMs: 5000,
        leaderLockAcquireAdditionalTimeMs: 5000,
        leaderLockRetryIntervalMs: 100,
      });
      const bElections: boolean[] = [];
      b.events.on("leaderElection", (won) => bElections.push(won));
      b.events.on("error", () => {});

      const inflight = b.subscribe();
      await setTimeout(300);
      await b.shutdown();

      // Release the real leader; a zombie B would now win the lock and the slot.
      await a.shutdown();
      await inflight.catch(() => {});
      await setTimeout(1500);

      const zombieWon = bElections.includes(true);
      const active = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_replication_slots WHERE slot_name = 'zombie_slot' AND active
      `;
      const backends = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = 'zombie-contender'
      `;
      // Reap a zombie (if any) so the test exits cleanly, then assert.
      await b.shutdown();

      expect(zombieWon).toBe(false);
      expect(Number(active[0].count)).toBe(0);
      expect(Number(backends[0].count)).toBe(0);
    }
  );

  postgresAndRedisTest(
    "subscribe after shutdown re-arms resubscribeOnFailure",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "rearm_slot",
        publicationName: "rearm_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      const b = new LogicalReplicationClient({
        ...shared,
        name: "rearm-client",
        resubscribeOnFailure: true,
        resubscribeMinDelayMs: 200,
        resubscribeMaxDelayMs: 400,
        leaderLockTimeoutMs: 500,
        leaderLockAcquireAdditionalTimeMs: 100,
        leaderLockRetryIntervalMs: 100,
      });
      const bElections: boolean[] = [];
      b.events.on("leaderElection", (won) => bElections.push(won));
      b.events.on("error", () => {});

      // Admin stop -> start: shutdown latches the intentional stop...
      await b.subscribe();
      await setTimeout(500);
      await b.shutdown();

      const a = new LogicalReplicationClient({ ...shared, name: "rearm-leader" });
      a.events.on("error", () => {});
      await a.subscribe();
      await setTimeout(1000);

      // ...then an explicit re-subscribe loses the election and must self-heal
      // once the leader goes away (self-heal re-armed by the subscribe).
      bElections.length = 0;
      await b.subscribe();
      expect(bElections).toContain(false);
      expect(bElections).not.toContain(true);

      await a.shutdown();

      let becameLeader = false;
      for (let i = 0; i < 40; i++) {
        if (bElections.includes(true)) {
          becameLeader = true;
          break;
        }
        await setTimeout(250);
      }
      expect(becameLeader).toBe(true);

      await b.shutdown();
    }
  );
});

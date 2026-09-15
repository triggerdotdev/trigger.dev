import { Redis } from "@internal/redis";
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
  // --- Leader-lock extend-failure recovery -------------------------------
  //
  // Redlock never repairs a Lock whose extend failed, so before these paths
  // existed a client that lost its lock kept the slot open and logged the same
  // error every interval until the process restarted.
  //
  // `lockKey` below repeats the `logical-replication-client:` segment on
  // purpose: the client's own Redis connection already carries it as a
  // keyPrefix, and the resource name adds it again, so this is the key redlock
  // really writes.

  const lockRecoveryOptions = {
    resubscribeMinDelayMs: 200,
    resubscribeMaxDelayMs: 400,
    leaderLockTimeoutMs: 2000,
    leaderLockExtendIntervalMs: 300,
    leaderLockAcquireAdditionalTimeMs: 200,
    leaderLockRetryIntervalMs: 100,
  };

  /** subscribe() rethrows a failed attempt after scheduling the retry. */
  async function tryCatchSubscribe(client: LogicalReplicationClient) {
    try {
      await client.subscribe();
    } catch {
      // expected: the resubscribe loop is what these tests observe
    }
  }

  /** Collect only the lock-related failures; stopping a client emits pg noise. */
  function watchLock(client: LogicalReplicationClient) {
    const elections: boolean[] = [];
    const errors: string[] = [];
    client.events.on("leaderElection", (won) => elections.push(won));
    client.events.on("error", (error) => {
      const message = String((error as Error)?.message ?? error);
      if (/already-expired|quorum|extend/i.test(message)) errors.push(message);
    });
    return { elections, errors };
  }

  postgresAndRedisTest(
    "a failed leader-lock extend re-acquires instead of looping forever",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_reacquire_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-reacquire",
        slotName,
        publicationName: "lock_reacquire_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
        resubscribeOnFailure: true,
      });
      const { elections, errors } = watchLock(client);

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);
        expect(await redis.exists(lockKey)).toBe(1);

        // The key vanishes under us (Redis restarted, or it simply expired) and
        // nobody else wants it. The next extend fails; we must take it back and
        // keep streaming, with no election flip and no surfaced error.
        await redis.del(lockKey);
        await setTimeout(1200); // several heartbeat ticks

        expect(await redis.exists(lockKey)).toBe(1);
        expect(elections).toEqual([true]);
        expect(errors).toHaveLength(0);
        expect(client.isStopped).toBe(false);
      } finally {
        await client.shutdown();
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "a leader-lock extend that cannot reach Redis keeps streaming inside the confirmed window",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_outage_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-outage",
        slotName,
        publicationName: "lock_outage_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
        resubscribeOnFailure: true,
      });
      const { elections, errors } = watchLock(client);

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);
        const valueBefore = await redis.get(lockKey);

        // Deny the scripted lock commands so every extend and re-acquire fails
        // while the key itself stays put: Redis is "unreachable" as far as the
        // lock is concerned. Inside the confirmed TTL nobody else can take the
        // key, so replication must continue untouched. (ACL changes apply to
        // already-connected clients.)
        await redis.call("ACL", "SETUSER", "default", "-eval", "-evalsha");
        try {
          await setTimeout(700); // 2-3 failed ticks, well inside the 2s TTL
          expect(elections).toEqual([true]);
          expect(errors).toHaveLength(0);
          expect(client.isStopped).toBe(false);
        } finally {
          await redis.call("ACL", "SETUSER", "default", "+eval", "+evalsha");
        }

        // Once Redis answers again we reclaim the SAME lock rather than
        // restarting the stream.
        await setTimeout(900);
        expect(await redis.get(lockKey)).toBe(valueBefore);
        expect(elections).toEqual([true]);
        expect(errors).toHaveLength(0);
        expect(client.isStopped).toBe(false);
      } finally {
        await client.shutdown();
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "a leader-lock taken by someone else steps down exactly once, then re-elects",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_stepdown_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-stepdown",
        slotName,
        publicationName: "lock_stepdown_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
        resubscribeOnFailure: true,
      });
      const { elections, errors } = watchLock(client);

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);

        // Another holder owns the key when our extend fails. Before the fix this
        // logged every interval forever; now it is one step-down.
        await redis.set(lockKey, "someone-else", "PX", 1500);
        await setTimeout(1200);
        expect(elections).toContain(false);
        expect(errors).toHaveLength(1);

        // ...and the normal resubscribe path wins the slot back once the other
        // holder lets go, without emitting anything further.
        let regained = false;
        for (let i = 0; i < 40; i++) {
          if (elections.filter(Boolean).length >= 2) {
            regained = true;
            break;
          }
          await setTimeout(250);
        }
        expect(regained).toBe(true);
        expect(errors).toHaveLength(1);
        expect(await redis.exists(lockKey)).toBe(1);
      } finally {
        await client.shutdown();
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "a client without resubscribe stops rather than streaming the slot lockless",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_noresub_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-noresub",
        slotName,
        publicationName: "lock_noresub_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      });
      const { elections, errors } = watchLock(client);

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);

        // With nothing to resubscribe to, losing the lock must still tear the
        // stream down: a non-leader holding the slot open is what kept the
        // replacement leader from making progress.
        await redis.set(lockKey, "someone-else", "PX", 1500);
        for (let i = 0; i < 30 && !elections.includes(false); i++) {
          await setTimeout(100);
        }
        await setTimeout(500); // let the pg client finish ending

        expect(elections).toEqual([true, false]);
        expect(errors).toHaveLength(1);
        expect(client.isStopped).toBe(true);

        const backends = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = 'lock-noresub'
        `;
        expect(Number(backends[0].count)).toBe(0);

        // The other holder expires; a stopped client must not quietly contend.
        await setTimeout(2000);
        expect(elections).toEqual([true, false]);
        expect(client.isStopped).toBe(true);
      } finally {
        await client.shutdown();
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "an extend rejection that lands after the lock was replaced starts no second recovery",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_stale_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-stale",
        slotName,
        publicationName: "lock_stale_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
        resubscribeOnFailure: true,
      });
      const { elections, errors } = watchLock(client);

      const redlock = client["redlock"];
      const realExtend = redlock.extend.bind(redlock);
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let extendSpy: ReturnType<typeof vi.spyOn> | undefined;
      let acquireSpy: ReturnType<typeof vi.spyOn> | undefined;

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);

        // Park the next extend in flight. This is the tick a slow Redis leaves
        // hanging while a later tick already failed, recovered, and moved on.
        let parked = false;
        extendSpy = vi
          .spyOn(redlock, "extend")
          .mockImplementation(async (...args: Parameters<typeof realExtend>) => {
            if (!parked) {
              parked = true;
              await gate;
            }
            return realExtend(...args);
          });
        acquireSpy = vi.spyOn(redlock, "acquire");

        await redis.set(lockKey, "someone-else", "PX", 1500);
        let regained = false;
        for (let i = 0; i < 60; i++) {
          if (elections.filter(Boolean).length >= 2) {
            regained = true;
            break;
          }
          await setTimeout(100);
        }
        expect(regained).toBe(true);
        expect(elections.filter((won) => !won)).toHaveLength(1);
        expect(errors).toHaveLength(1);

        // Re-election fires before the new stream is up; wait for it so the
        // stale rejection meets a running client, not one mid-subscribe.
        for (let i = 0; i < 40 && client.isStopped; i++) {
          await setTimeout(100);
        }
        expect(client.isStopped).toBe(false);

        // Now release the parked extend. Its lock was dropped at the step-down
        // and replaced at re-election, so it must be ignored outright.
        const acquiresBefore = acquireSpy.mock.calls.length;
        openGate();
        await setTimeout(600);

        expect(acquireSpy.mock.calls.length).toBe(acquiresBefore);
        expect(elections.filter((won) => !won)).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(client.isStopped).toBe(false);
        expect(await redis.exists(lockKey)).toBe(1);
      } finally {
        openGate();
        extendSpy?.mockRestore();
        acquireSpy?.mockRestore();
        await client.shutdown();
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "shutdown during a leader-lock recovery releases the re-acquired lock and stays quiet",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const slotName = "lock_shutdown_slot";
      const lockKey = `logical-replication-client:${slotName}`;
      const redis = new Redis({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix}logical-replication-client:`,
      });

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-shutdown",
        slotName,
        publicationName: "lock_shutdown_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
        resubscribeOnFailure: true,
      });
      const { elections, errors } = watchLock(client);

      const redlock = client["redlock"];
      const realAcquire = redlock.acquire.bind(redlock);
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let acquireSpy: ReturnType<typeof vi.spyOn> | undefined;

      try {
        await client.subscribe();
        expect(elections).toEqual([true]);

        // Hold the recovery's re-acquire open so shutdown() lands while it is
        // still in flight: the window a slow Redis opens in production.
        acquireSpy = vi
          .spyOn(redlock, "acquire")
          .mockImplementation(async (...args: Parameters<typeof realAcquire>) => {
            await gate;
            return realAcquire(...args);
          });

        await redis.del(lockKey);
        for (let i = 0; i < 30 && acquireSpy.mock.calls.length === 0; i++) {
          await setTimeout(100);
        }
        expect(acquireSpy.mock.calls.length).toBeGreaterThan(0);

        await client.shutdown();
        openGate();
        await setTimeout(600); // > resubscribeMaxDelayMs: a stray resubscribe would have fired

        // shutdown() owns the teardown, so the lock the recovery won is handed
        // back and nothing is announced.
        expect(await redis.exists(lockKey)).toBe(0);
        expect(elections).toEqual([true]);
        expect(errors).toHaveLength(0);
        expect(client.isStopped).toBe(true);
      } finally {
        openGate();
        acquireSpy?.mockRestore();
        await client.shutdown();
        await redis.quit();
      }
    }
  );
  postgresAndRedisTest(
    "a bounded client gives up and reports unrecoverable instead of retrying forever",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-giveup",
        slotName: "lock_giveup_slot",
        publicationName: "lock_giveup_pub",
        redisOptions,
        table: "TaskRun",
        // Nothing listens here, so every attempt fails at connect() and the
        // resubscribe loop runs to its budget instead of recovering.
        pgConfig: { connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres" },
        resubscribeOnFailure: true,
        maxResubscribeAttempts: 2,
      });

      const unrecoverable: { reason: string; attempts: number }[] = [];
      client.events.on("unrecoverable", (info) => unrecoverable.push(info));
      client.events.on("error", () => {});

      try {
        await tryCatchSubscribe(client);

        for (let i = 0; i < 60 && unrecoverable.length === 0; i++) {
          await setTimeout(100);
        }

        // Exactly one report, at the configured budget, and nothing after it:
        // the loop is genuinely stopped, not merely slowed down.
        expect(unrecoverable).toHaveLength(1);
        expect(unrecoverable[0].attempts).toBe(2);
        await setTimeout(1500);
        expect(unrecoverable).toHaveLength(1);
      } finally {
        await client.shutdown();
      }
    }
  );

  postgresAndRedisTest(
    "an unbounded client keeps retrying and never reports unrecoverable",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const client = new LogicalReplicationClient({
        ...lockRecoveryOptions,
        name: "lock-unbounded",
        slotName: "lock_unbounded_slot",
        publicationName: "lock_unbounded_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres" },
        resubscribeOnFailure: true,
        // maxResubscribeAttempts left at its default of 0.
      });

      const unrecoverable: unknown[] = [];
      client.events.on("unrecoverable", (info) => unrecoverable.push(info));
      client.events.on("error", () => {});

      try {
        await tryCatchSubscribe(client);
        await setTimeout(2000); // well past where the bounded client gave up
        expect(unrecoverable).toHaveLength(0);
      } finally {
        await client.shutdown();
      }
    }
  );
  postgresAndRedisTest(
    "a follower losing elections never spends the give-up budget",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const shared = {
        slotName: "lock_follower_slot",
        publicationName: "lock_follower_pub",
        redisOptions,
        table: "TaskRun" as const,
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      };

      // The leader holds the slot lock for the whole test.
      const leader = new LogicalReplicationClient({
        ...shared,
        name: "follower-test-leader",
        leaderLockTimeoutMs: 4000,
        leaderLockExtendIntervalMs: 500,
      });
      leader.events.on("error", () => {});

      // The follower keeps losing the election, which is its normal state in any
      // multi-replica deployment. That must never be mistaken for a stream it
      // cannot recover, or the host restarts a perfectly healthy process.
      const follower = new LogicalReplicationClient({
        ...shared,
        name: "follower-test-follower",
        resubscribeOnFailure: true,
        resubscribeMinDelayMs: 100,
        resubscribeMaxDelayMs: 200,
        // Each losing election costs about
        // leaderLockTimeoutMs + leaderLockAcquireAdditionalTimeMs, so keep it
        // short enough to lose several within the window below.
        leaderLockTimeoutMs: 500,
        leaderLockExtendIntervalMs: 200,
        leaderLockAcquireAdditionalTimeMs: 100,
        leaderLockRetryIntervalMs: 50,
        maxResubscribeAttempts: 2,
      });
      const unrecoverable: unknown[] = [];
      const lost: boolean[] = [];
      follower.events.on("unrecoverable", (info) => unrecoverable.push(info));
      follower.events.on("leaderElection", (won) => lost.push(won));
      follower.events.on("error", () => {});

      try {
        await leader.subscribe();
        await setTimeout(300);

        await tryCatchSubscribe(follower);
        await setTimeout(4000); // many more failed elections than the budget of 2

        expect(lost.filter((won) => !won).length).toBeGreaterThan(2);
        expect(unrecoverable).toHaveLength(0);

        // And once the leader leaves, the follower takes over.
        await leader.shutdown();
        let won = false;
        for (let i = 0; i < 60; i++) {
          if (lost.includes(true)) {
            won = true;
            break;
          }
          await setTimeout(250);
        }
        expect(won).toBe(true);
        expect(unrecoverable).toHaveLength(0);
      } finally {
        await leader.shutdown();
        await follower.shutdown();
      }
    }
  );
});

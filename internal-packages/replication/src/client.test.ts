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
});

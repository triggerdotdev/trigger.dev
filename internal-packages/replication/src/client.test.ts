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
});

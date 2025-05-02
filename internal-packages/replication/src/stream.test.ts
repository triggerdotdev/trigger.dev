import { postgresAndRedisTest } from "@internal/testcontainers";
import { createSubscription, Transaction } from "./stream.js";
import { setTimeout } from "timers/promises";

describe("LogicalReplicationStream", () => {
  postgresAndRedisTest(
    "should group changes by transaction and filter relevant events",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      type TaskRunData = {
        friendlyId: string;
        taskIdentifier: string;
        payload: string;
        traceId: string;
        spanId: string;
        queue: string;
        runtimeEnvironmentId: string;
        projectId: string;
      };

      const received: Transaction<TaskRunData>[] = [];

      const subscription = createSubscription<TaskRunData>({
        name: "test_stream",
        publicationName: "test_publication_stream",
        slotName: "test_slot_stream",
        pgConfig: {
          connectionString: postgresContainer.getConnectionUri(),
        },
        table: "TaskRun",
        redisOptions,
        filterTags: ["insert"],
        abortSignal: AbortSignal.timeout(10000),
      });

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

      // Insert a row into the table
      new Promise(async (resolve) => {
        await setTimeout(2000);

        await prisma.taskRun.create({
          data: {
            friendlyId: "run_5678",
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: "5678",
            spanId: "5678",
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
          },
        });

        resolve(undefined);
      }).then(() => {});
      // Now we want to read from the stream
      for await (const transaction of subscription.stream) {
        received.push(transaction);
      }

      console.log(received);

      expect(received.length).toBeGreaterThan(0);
      const transaction = received[0];
      expect(transaction.events.length).toBeGreaterThan(0);
      expect(transaction.events[0].data.friendlyId).toBe("run_5678");

      // Clean up
      await subscription.client.stop();
    }
  );
});

// A publication that exists but carries no tables is the failure that replicated NOTHING in
// production while every log line said "healthy" and boot passed: the source IS configured, so
// the boot-time coverage assert cannot see it, and the client just retries every 30s.
//
// The client already detects it. What was missing is a way for the owner to COUNT it, which needs
// the emitted error to be distinguishable from any other client error. This drives the real
// client against a real publication with no tables and pins that type.
import { postgresAndRedisTest } from "@internal/testcontainers";
import { LogicalReplicationClient } from "./client.js";
import { PublicationMisconfiguredError } from "./errors.js";

describe("publication with no tables", () => {
  postgresAndRedisTest(
    "emits a typed PublicationMisconfiguredError rather than a bare client error",
    async ({ postgresContainer, prisma, redisOptions }) => {
      // The exact production shape: the publication exists, so the client adopts it instead of
      // creating one, and validation finds it carries no tables at all.
      await prisma.$executeRawUnsafe(`CREATE PUBLICATION no_tables_pub;`);

      const client = new LogicalReplicationClient({
        name: "no-tables",
        slotName: "no_tables_slot",
        publicationName: "no_tables_pub",
        redisOptions,
        table: "TaskRun",
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      });

      const errors: unknown[] = [];
      client.events.on("error", (error) => errors.push(error));

      await client.subscribe();
      await client.shutdown();

      const misconfigured = errors.filter((e) => e instanceof PublicationMisconfiguredError);
      expect(misconfigured).toHaveLength(1);

      const error = misconfigured[0] as PublicationMisconfiguredError;
      expect(error.publicationName).toBe("no_tables_pub");
      expect(error.table).toBe("TaskRun");
      expect(error.message).toContain("NO TABLES configured");
    }
  );
});

describe("publication missing a recreated main table", () => {
  postgresAndRedisTest(
    "re-adds the main table instead of reporting it misconfigured when readdMainTable is set",
    async ({ postgresContainer, prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(`CREATE PUBLICATION readd_pub;`);

      const client = new LogicalReplicationClient({
        name: "readd",
        slotName: "readd_slot",
        publicationName: "readd_pub",
        redisOptions,
        table: "TaskRun",
        readdMainTable: true,
        pgConfig: { connectionString: postgresContainer.getConnectionUri() },
      });

      const errors: unknown[] = [];
      client.events.on("error", (error) => errors.push(error));

      await client.subscribe();
      await client.shutdown();

      expect(errors.filter((e) => e instanceof PublicationMisconfiguredError)).toHaveLength(0);
      const published = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_publication_tables WHERE pubname = 'readd_pub'`
      );
      expect(published.map((row) => row.tablename)).toEqual(["TaskRun"]);
    }
  );
});

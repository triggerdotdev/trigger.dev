import { PrismaClient, Prisma } from "@trigger.dev/database";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "path";
import { execSync } from "child_process";
import exp from "constants";

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

describe("Placeholder", () => {
  beforeEach(async () => {
    container = await new PostgreSqlContainer().start();

    // Run migrations
    const databasePath = path.resolve(__dirname, "../../database");
    try {
      execSync(`npx prisma db push --schema ${databasePath}/prisma/schema.prisma`, {
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          DIRECT_URL: container.getConnectionUri(),
        },
      });
    } catch (error) {
      expect(error).toBeUndefined();
    }

    // console.log(container.getConnectionUri());

    prisma = new PrismaClient({
      datasources: {
        db: {
          url: container.getConnectionUri(),
        },
      },
    });
    prisma.$connect();
  }, 10_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  }, 10_000);

  it("should get a user from Postgres", async () => {
    const user = await prisma.user.create({
      data: {
        authenticationMethod: "MAGIC_LINK",
        email: "test@example.com",
      },
    });

    const result = await prisma.user.findMany();
    expect(result.length).toEqual(1);
    expect(result[0].email).toEqual("test@example.com");
  });
});

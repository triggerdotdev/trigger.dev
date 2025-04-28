import { ClickHouseClient } from "@clickhouse/client";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AbstractStartedContainer,
  GenericContainer,
  StartedTestContainer,
  Wait,
} from "testcontainers";

const CLICKHOUSE_PORT = 9000;
const CLICKHOUSE_HTTP_PORT = 8123;

export class ClickHouseContainer extends GenericContainer {
  private username = "test";
  private password = "test";
  private database = "test";

  constructor(image = "clickhouse/clickhouse-server:25.4-alpine") {
    super(image);
    this.withExposedPorts(CLICKHOUSE_PORT, CLICKHOUSE_HTTP_PORT);
    this.withWaitStrategy(
      Wait.forHttp("/", CLICKHOUSE_HTTP_PORT).forResponsePredicate(
        (response) => response === "Ok.\n"
      )
    );
    this.withStartupTimeout(120_000);

    // Setting this high ulimits value proactively prevents the "Too many open files" error,
    //  especially under potentially heavy load during testing.
    this.withUlimits({
      nofile: {
        hard: 262144,
        soft: 262144,
      },
    });
  }

  public withDatabase(database: string): this {
    this.database = database;
    return this;
  }

  public withUsername(username: string): this {
    this.username = username;
    return this;
  }

  public withPassword(password: string): this {
    this.password = password;
    return this;
  }

  public override async start(): Promise<StartedClickHouseContainer> {
    this.withEnvironment({
      CLICKHOUSE_USER: this.username,
      CLICKHOUSE_PASSWORD: this.password,
      CLICKHOUSE_DB: this.database,
    });

    return new StartedClickHouseContainer(
      await super.start(),
      this.database,
      this.username,
      this.password
    );
  }
}

export class StartedClickHouseContainer extends AbstractStartedContainer {
  constructor(
    startedTestContainer: StartedTestContainer,
    private readonly database: string,
    private readonly username: string,
    private readonly password: string
  ) {
    super(startedTestContainer);
  }

  public getPort(): number {
    return super.getMappedPort(CLICKHOUSE_PORT);
  }

  public getHttpPort(): number {
    return super.getMappedPort(CLICKHOUSE_HTTP_PORT);
  }

  public getUsername(): string {
    return this.username;
  }

  public getPassword(): string {
    return this.password;
  }

  public getDatabase(): string {
    return this.database;
  }

  /**
   * Gets the base HTTP URL (protocol, host and mapped port) for the ClickHouse container's HTTP interface.
   * Example: `http://localhost:32768`
   */
  public getHttpUrl(): string {
    const protocol = "http";
    const host = this.getHost();
    const port = this.getHttpPort();
    return `${protocol}://${host}:${port}`;
  }

  /**
   * Gets configuration options suitable for passing directly to `createClient({...})`
   * from `@clickhouse/client`. Uses the HTTP interface.
   */
  public getClientOptions(): {
    url?: string;
    username: string;
    password: string;
    database: string;
  } {
    return {
      url: this.getHttpUrl(),
      username: this.getUsername(),
      password: this.getPassword(),
      database: this.getDatabase(),
    };
  }

  /**
   * Gets a ClickHouse connection URL for the HTTP interface with format:
   * http://username:password@hostname:port/database
   * @returns The ClickHouse HTTP URL string.
   */
  public getConnectionUrl(): string {
    const url = new URL(this.getHttpUrl());

    url.username = this.getUsername();
    url.password = this.getPassword();

    const dbName = this.getDatabase();
    url.pathname = dbName.startsWith("/") ? dbName : `/${dbName}`;

    return url.toString();
  }
}

export async function runClickhouseMigrations(client: ClickHouseClient, migrationsPath: string) {
  // Get all the *.sql files in the migrations path
  const queries = await getAllClickhouseMigrationQueries(migrationsPath);

  for (const query of queries) {
    await client.command({
      query,
    });
  }
}

async function getAllClickhouseMigrationQueries(migrationsPath: string) {
  const queries: string[] = [];
  // Get all the *.sql files in the migrations path
  const migrations = await readdir(migrationsPath);

  for (const migration of migrations) {
    const migrationPath = resolve(migrationsPath, migration);

    const migrationContent = await readFile(migrationPath, "utf-8");

    // Split content by goose markers
    const parts = migrationContent.split(/--\s*\+goose\s+(Up|Down)/i);

    // The array will be: ["", "Up", "up queries", "Down", "down queries"]
    // We want the "up queries" part which is at index 2
    if (parts.length >= 3) {
      const upQueries = parts[2].trim();
      queries.push(
        ...upQueries
          .split(";")
          .filter((q) => q.trim())
          .map((q) => q.trim())
      );
    }
  }

  return queries;
}

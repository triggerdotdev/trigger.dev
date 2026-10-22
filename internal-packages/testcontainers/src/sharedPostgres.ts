import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  getDatabaseSchemaSql,
  getRunOpsSchemaSql,
  postgresUriWithDatabase,
  runSql,
  withTestPostgresSettings,
} from "./utils";

const SHARED_CONTAINER_LABEL = "dev.trigger.testcontainers.shared";

const STALE_CLONE_MS = 2 * 60 * 60 * 1000;
// Full clone names only: a template mid-build is not yet datistemplate and must never be reaped.
const CLONE_NAME = /^t([0-9a-z]+)_.+_[0-9a-f]{8}$/;

const PG17_INITDB_ARGS = "--locale-provider=icu --icu-locale=en-US --encoding=UTF8";

let sharedPostgres14: Promise<SharedPostgres> | undefined;
let sharedPostgres17: Promise<SharedPostgres> | undefined;
let sharedRunOpsPostgres17: Promise<SharedPostgres> | undefined;
let privatePostgres14: Promise<SharedPostgres> | undefined;

/** PG14 with the full @trigger.dev/database schema. */
export const getSharedPostgres14 = () =>
  (sharedPostgres14 ??= startSharedPostgres({
    image: "docker.io/postgres:14",
    schemaSql: getDatabaseSchemaSql(),
  }));

/** PG17 (ICU cluster locale) with the full @trigger.dev/database schema. */
export const getSharedPostgres17 = () =>
  (sharedPostgres17 ??= startSharedPostgres({
    image: "docker.io/postgres:17",
    initdbArgs: PG17_INITDB_ARGS,
    schemaSql: getDatabaseSchemaSql(),
  }));

/** The same PG17 container with the dedicated run-ops subset schema. */
export const getSharedRunOpsPostgres17 = () =>
  (sharedRunOpsPostgres17 ??= startSharedPostgres({
    image: "docker.io/postgres:17",
    initdbArgs: PG17_INITDB_ARGS,
    schemaSql: getRunOpsSchemaSql(),
  }));

/**
 * A PG14 with the full schema private to this test file, for tests that create cluster-wide state
 * under fixed names (logical replication slots) and so can't share a container across processes.
 */
export const getPrivatePostgres14 = () =>
  (privatePostgres14 ??= startSharedPostgres({
    image: "docker.io/postgres:14",
    schemaSql: getDatabaseSchemaSql(),
    reuse: false,
  }));

/** Boots every shared Postgres and builds its templates, so parallel test processes find them ready. */
export async function warmSharedPostgres(): Promise<void> {
  await Promise.all([getSharedPostgres14(), getSharedPostgres17()]);
  await getSharedRunOpsPostgres17();
}

/** A reusable Postgres container plus the name of a template database holding one schema. */
export type SharedPostgres = {
  container: StartedPostgreSqlContainer;
  template: string;
};

/**
 * Starts (or reuses, across test files and processes) a Postgres container for `image`, and makes
 * sure it holds a template database built from `schemaSql`. The template is named by the schema's
 * hash and built under an advisory lock, so concurrent processes and different schemas can share
 * one container. Set TESTCONTAINERS_REUSE_ENABLE=false to get a private container instead.
 */
async function startSharedPostgres({
  image,
  initdbArgs,
  schemaSql,
  reuse = true,
}: {
  image: string;
  initdbArgs?: string;
  schemaSql: Promise<string>;
  reuse?: boolean;
}): Promise<SharedPostgres> {
  const shared = reuse && process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";
  const createBuilder = () => {
    let builder = withTestPostgresSettings(new PostgreSqlContainer(image));
    if (shared) {
      builder = builder.withReuse().withLabels({ [SHARED_CONTAINER_LABEL]: "postgres" });
    }
    if (initdbArgs) {
      builder = builder.withEnvironment({ POSTGRES_INITDB_ARGS: initdbArgs });
    }
    return builder;
  };

  const [container, sql] = await Promise.all([
    shared ? startNamedReusable(createBuilder) : createBuilder().start(),
    schemaSql,
  ]);
  const template = `template_${createHash("sha256").update(sql).digest("hex").slice(0, 16)}`;

  await withAdmin(container, async (admin) => {
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [template]);
    try {
      const { rows } = await admin.query<{ datistemplate: boolean }>(
        "SELECT datistemplate FROM pg_database WHERE datname = $1",
        [template]
      );
      if (!rows[0]?.datistemplate) {
        await admin.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${template}"`);
        await runSql(postgresUriWithDatabase(container.getConnectionUri(), template), sql);
        await admin.query(`ALTER DATABASE "${template}" IS_TEMPLATE true ALLOW_CONNECTIONS false`);
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [template]);
    }
    await dropStaleClones(admin);
  });

  return { container, template };
}

/** Clones a fresh database from the template. Names are unique across processes. */
export async function cloneDatabase(shared: SharedPostgres, prefix: string): Promise<string> {
  const name = `t${Date.now().toString(36)}_${prefix}_${randomBytes(4).toString("hex")}`;
  await withAdmin(shared.container, (admin) =>
    admin.query(`CREATE DATABASE "${name}" TEMPLATE "${shared.template}"`)
  );
  return name;
}

/**
 * Best-effort drop; a failure is harmless because stale clones are reaped on the next start. A
 * database with a logical replication slot can't be dropped, so its slots go first.
 */
export async function dropDatabase(shared: SharedPostgres, name: string): Promise<void> {
  try {
    await withAdmin(shared.container, async (admin) => {
      await dropReplicationSlots(admin, name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    });
  } catch {}
}

/** Clones a database for the duration of `use` and drops it afterwards. */
export async function withClonedDatabase(
  shared: Promise<SharedPostgres>,
  prefix: string,
  use: (uri: string) => Promise<void>
): Promise<void> {
  const pg = await shared;
  const name = await cloneDatabase(pg, prefix);
  try {
    await use(postgresUriWithDatabase(pg.container.getConnectionUri(), name));
  } finally {
    await dropDatabase(pg, name);
  }
}

async function dropReplicationSlots(admin: Client, database: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await admin.query<{ slot_name: string; active_pid: number | null }>(
      "SELECT slot_name, active_pid FROM pg_replication_slots WHERE database = $1",
      [database]
    );
    if (rows.length === 0) return;
    for (const { slot_name, active_pid } of rows) {
      if (active_pid !== null) {
        await admin.query("SELECT pg_terminate_backend($1)", [active_pid]);
      } else {
        await admin.query("SELECT pg_drop_replication_slot($1)", [slot_name]).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function dropStaleClones(admin: Client) {
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE NOT datistemplate"
  );
  const cutoff = Date.now() - STALE_CLONE_MS;
  for (const { datname } of rows) {
    const match = CLONE_NAME.exec(datname);
    if (match && parseInt(match[1]!, 36) < cutoff) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
  }
}

const NAMED_START_DEADLINE_MS = 5 * 60_000;

/**
 * Starts a reusable container under a name fixed by its config. Testcontainers' reuse lookup is
 * locked per process only, so cold parallel processes can all miss it; Docker refuses a second
 * container with the same name, and the losers retry with a fresh builder (a started builder's
 * options carry its reuse hash, so it can't look up again) until they find the winner's.
 */
async function startNamedReusable(
  createBuilder: () => PostgreSqlContainer
): Promise<StartedPostgreSqlContainer> {
  const name = containerName(createBuilder());
  const deadline = performance.now() + NAMED_START_DEADLINE_MS;
  for (;;) {
    try {
      return await createBuilder().withName(name).start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lostRace = /conflict|already in use|already started/i.test(message);
      if (!lostRace || performance.now() > deadline) {
        throw new Error(
          `Could not start shared test container ${name}. If an incompatible one is left over, remove it with: docker rm -f ${name}`,
          { cause: error }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** A name derived from everything the builder will create the container with. */
function containerName(builder: PostgreSqlContainer): string {
  const { createOpts, hostConfig } = builder as unknown as {
    createOpts: unknown;
    hostConfig: unknown;
  };
  const hash = createHash("sha256")
    .update(JSON.stringify({ createOpts, hostConfig }))
    .digest("hex")
    .slice(0, 12);
  return `trigger-test-postgres-${hash}`;
}

async function withAdmin<T>(
  container: StartedPostgreSqlContainer,
  fn: (admin: Client) => Promise<T>
): Promise<T> {
  const admin = new Client({
    connectionString: postgresUriWithDatabase(container.getConnectionUri(), "postgres"),
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

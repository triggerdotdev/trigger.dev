import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it, vi } from "vitest";
import {
  buildReplicaClient,
  buildWriterClient,
  sameDatabaseTarget,
  selectRunOpsTopology,
} from "~/db.server";

const cp = { writer: {} as any, replica: {} as any };

describe("selectRunOpsTopology (pure)", () => {
  it("split OFF: all run-ops handles collapse to control-plane and NO client is built", () => {
    const buildNewWriter = vi.fn();
    const buildNewReplica = vi.fn();
    const buildLegacyWriter = vi.fn();
    const buildLegacyReplica = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: false, legacyUrl: "postgres://a", newUrl: "postgres://b" },
      { controlPlane: cp, buildNewWriter, buildNewReplica, buildLegacyWriter, buildLegacyReplica }
    );
    // new + legacy run-ops collapse to the control-plane client refs (no second connection).
    expect(topo.newRunOps.writer).toBe(cp.writer);
    expect(topo.newRunOps.replica).toBe(cp.replica);
    expect(topo.legacyRunOps).toBe(cp);
    expect(topo.controlPlane).toBe(cp);
    expect(buildNewWriter).not.toHaveBeenCalled(); // no second connection opened
    expect(buildNewReplica).not.toHaveBeenCalled();
    expect(buildLegacyWriter).not.toHaveBeenCalled();
    expect(buildLegacyReplica).not.toHaveBeenCalled();
  });

  it("split ON but a URL missing: still aliases legacy to control-plane and builds nothing", () => {
    const buildNewWriter = vi.fn();
    const buildLegacyWriter = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: true, newUrl: "postgres://b" }, // no legacyUrl
      {
        controlPlane: cp,
        buildNewWriter,
        buildNewReplica: vi.fn(),
        buildLegacyWriter,
        buildLegacyReplica: vi.fn(),
      }
    );
    expect(topo.legacyRunOps).toBe(cp);
    expect(topo.newRunOps.writer).toBe(cp.writer);
    expect(buildNewWriter).not.toHaveBeenCalled();
    expect(buildLegacyWriter).not.toHaveBeenCalled();
  });

  it("split ON + legacySharesControlPlane: aliases legacy to control-plane and builds NO legacy client", () => {
    const newWriter = { tag: "nw" } as any;
    const newReplica = { tag: "nr" } as any;
    const buildNewWriter = vi.fn().mockReturnValue(newWriter);
    const buildNewReplica = vi.fn().mockReturnValue(newReplica);
    const buildLegacyWriter = vi.fn();
    const buildLegacyReplica = vi.fn();
    const topo = selectRunOpsTopology(
      {
        splitEnabled: true,
        legacyUrl: "postgres://same",
        legacyReplicaUrl: "postgres://same-r",
        newUrl: "postgres://new",
        newReplicaUrl: "postgres://new-r",
        legacySharesControlPlane: true,
      },
      { controlPlane: cp, buildNewWriter, buildNewReplica, buildLegacyWriter, buildLegacyReplica }
    );
    // Legacy reuses the control-plane pair by reference — no second pool against the same server.
    expect(topo.legacyRunOps).toBe(cp);
    expect(buildLegacyWriter).not.toHaveBeenCalled();
    expect(buildLegacyReplica).not.toHaveBeenCalled();
    // New run-ops still builds its own (independent) client.
    expect(topo.newRunOps.writer).toBe(newWriter);
    expect(topo.newRunOps.replica).toBe(newReplica);
  });

  it("split ON (flag off): legacy builds its OWN writer + replica (independent, not aliased)", () => {
    const newWriter = { tag: "nw" } as any;
    const newReplica = { tag: "nr" } as any;
    const legacyWriter = { tag: "lw" } as any;
    const legacyReplica = { tag: "lr" } as any;
    const buildNewWriter = vi.fn().mockReturnValue(newWriter);
    const buildNewReplica = vi.fn().mockReturnValue(newReplica);
    const buildLegacyWriter = vi.fn().mockReturnValue(legacyWriter);
    const buildLegacyReplica = vi.fn().mockReturnValue(legacyReplica);
    const topo = selectRunOpsTopology(
      {
        splitEnabled: true,
        legacyUrl: "postgres://legacy",
        legacyReplicaUrl: "postgres://legacy-r",
        newUrl: "postgres://new",
        newReplicaUrl: "postgres://new-r",
      },
      { controlPlane: cp, buildNewWriter, buildNewReplica, buildLegacyWriter, buildLegacyReplica }
    );
    expect(topo.newRunOps.writer).toBe(newWriter);
    expect(topo.newRunOps.replica).toBe(newReplica);
    expect(topo.controlPlane).toBe(cp);
    // Track 2: legacy is its own independent client now, NOT the control-plane pair.
    expect(topo.legacyRunOps).not.toBe(cp);
    expect(topo.legacyRunOps.writer).toBe(legacyWriter);
    expect(topo.legacyRunOps.replica).toBe(legacyReplica);
    expect(buildLegacyWriter).toHaveBeenCalledTimes(1);
    expect(buildLegacyReplica).toHaveBeenCalledTimes(1);
  });

  it("split ON without a new replica URL: new replica falls back to the new writer", () => {
    const newWriter = { tag: "nw" } as any;
    const buildNewWriter = vi.fn().mockReturnValue(newWriter);
    const buildNewReplica = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: true, legacyUrl: "postgres://legacy", newUrl: "postgres://new" },
      {
        controlPlane: cp,
        buildNewWriter,
        buildNewReplica,
        buildLegacyWriter: vi.fn().mockReturnValue({ tag: "lw" } as any),
        buildLegacyReplica: vi.fn(),
      }
    );
    expect(topo.newRunOps.replica).toBe(newWriter);
    expect(buildNewReplica).not.toHaveBeenCalled();
  });

  it("split ON without a legacy replica URL: legacy replica falls back to the legacy writer", () => {
    const legacyWriter = { tag: "lw" } as any;
    const buildLegacyWriter = vi.fn().mockReturnValue(legacyWriter);
    const buildLegacyReplica = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: true, legacyUrl: "postgres://legacy", newUrl: "postgres://new" },
      {
        controlPlane: cp,
        buildNewWriter: vi.fn().mockReturnValue({ tag: "nw" } as any),
        buildNewReplica: vi.fn(),
        buildLegacyWriter,
        buildLegacyReplica,
      }
    );
    expect(topo.legacyRunOps.writer).toBe(legacyWriter);
    expect(topo.legacyRunOps.replica).toBe(legacyWriter);
    expect(buildLegacyReplica).not.toHaveBeenCalled();
  });
});

describe("sameDatabaseTarget", () => {
  it("same host/port/db/user is a match despite differing query params and password", () => {
    expect(
      sameDatabaseTarget(
        "postgresql://user:secret1@db.internal:5432/trigger?connection_limit=10&application_name=api",
        "postgresql://user:secret2@db.internal:5432/trigger?connection_limit=55"
      )
    ).toBe(true);
  });

  it("treats a missing port as the default 5432", () => {
    expect(
      sameDatabaseTarget(
        "postgresql://user@db.internal/trigger",
        "postgresql://user@db.internal:5432/trigger"
      )
    ).toBe(true);
  });

  it("differs on host, port, dbname, or user", () => {
    const base = "postgresql://user@db.internal:5432/trigger";
    expect(sameDatabaseTarget(base, "postgresql://user@other.internal:5432/trigger")).toBe(false);
    expect(sameDatabaseTarget(base, "postgresql://user@db.internal:6432/trigger")).toBe(false);
    expect(sameDatabaseTarget(base, "postgresql://user@db.internal:5432/other")).toBe(false);
    expect(sameDatabaseTarget(base, "postgresql://other@db.internal:5432/trigger")).toBe(false);
  });

  it("returns false for undefined or unparseable input", () => {
    expect(sameDatabaseTarget(undefined, "postgresql://user@db/trigger")).toBe(false);
    expect(sameDatabaseTarget("postgresql://user@db/trigger", undefined)).toBe(false);
    expect(sameDatabaseTarget("not a url", "also not a url")).toBe(false);
  });

  it("matches the prod-shaped legacy-vs-cp writer pair, not the new replica", () => {
    const cpWriter = "postgresql://master:pw@rds-writer.internal:5432/pgtrigger";
    const legacyWriter =
      "postgresql://master:pw@rds-writer.internal:5432/pgtrigger?connection_limit=25";
    const newReplica = "postgresql://master%7Creplica:pw@ps-host.internal:5432/pgtrigger";
    expect(sameDatabaseTarget(cpWriter, legacyWriter)).toBe(true);
    expect(sameDatabaseTarget(cpWriter, newReplica)).toBe(false);
  });
});

describe("selectRunOpsTopology (integration, real containers)", () => {
  it("split OFF: opens exactly one DB; all run-ops handles share the control-plane client", async () => {
    const pg = await new PostgreSqlContainer("docker.io/postgres:14").start();
    try {
      const cpWriter = buildWriterClient({ url: pg.getConnectionUri(), clientType: "cp" });
      const cp = { writer: cpWriter, replica: cpWriter };
      const builtUrls: string[] = [];
      const topo = selectRunOpsTopology(
        { splitEnabled: false, legacyUrl: pg.getConnectionUri(), newUrl: pg.getConnectionUri() },
        {
          controlPlane: cp,
          buildNewWriter: (url) => {
            builtUrls.push(url);
            return buildWriterClient({ url, clientType: "x" }) as any;
          },
          buildNewReplica: (url) => {
            builtUrls.push(url);
            return buildReplicaClient({ url, clientType: "x" }) as any;
          },
          buildLegacyWriter: (url) => {
            builtUrls.push(url);
            return buildWriterClient({ url, clientType: "legacy" });
          },
          buildLegacyReplica: (url) => {
            builtUrls.push(url);
            return buildReplicaClient({ url, clientType: "legacy" });
          },
        }
      );
      expect(builtUrls).toHaveLength(0); // no second connection opened (legacy included)
      expect(topo.newRunOps.writer).toBe(cp.writer);
      expect(topo.newRunOps.replica).toBe(cp.replica);
      expect(topo.legacyRunOps).toBe(cp);
      await topo.newRunOps.writer.$queryRawUnsafe("SELECT 1");
      await cpWriter.$disconnect();
    } finally {
      await pg.stop();
    }
  }, 60_000);

  it("split ON (flag off): constructs CP + INDEPENDENT legacy-run-ops + new-run-ops + replicas", async () => {
    const rds = await new PostgreSqlContainer("docker.io/postgres:14").start();
    const ps = await new PostgreSqlContainer("docker.io/postgres:17").start();
    try {
      const cpWriter = buildWriterClient({ url: rds.getConnectionUri(), clientType: "cp" });
      const cp = { writer: cpWriter, replica: cpWriter };
      const topo = selectRunOpsTopology(
        {
          splitEnabled: true,
          // Divergent-DB stage (legacySharesControlPlane omitted): legacy builds an INDEPENDENT
          // client with its own pool — never the cp object.
          legacyUrl: rds.getConnectionUri(),
          legacyReplicaUrl: rds.getConnectionUri(),
          newUrl: ps.getConnectionUri(),
        },
        {
          controlPlane: cp,
          buildNewWriter: (url, ct) => buildWriterClient({ url, clientType: ct }) as any,
          buildNewReplica: (url, ct) => buildReplicaClient({ url, clientType: ct }) as any,
          buildLegacyWriter: (url, ct) => buildWriterClient({ url, clientType: ct }),
          buildLegacyReplica: (url, ct) => buildReplicaClient({ url, clientType: ct }),
        }
      );
      expect(topo.controlPlane).toBe(cp);
      // Track 2: legacy is an independent client, never the control-plane pair/refs.
      expect(topo.legacyRunOps).not.toBe(cp);
      expect(topo.legacyRunOps.writer).not.toBe(cpWriter);
      expect(topo.newRunOps.writer).not.toBe(cpWriter);
      await topo.controlPlane.writer.$queryRawUnsafe("SELECT 1");
      await topo.legacyRunOps.writer.$queryRawUnsafe("SELECT 1");
      await topo.newRunOps.writer.$queryRawUnsafe("SELECT 1");
      const ver = await topo.newRunOps.writer.$queryRawUnsafe<Array<{ v: string }>>(
        "SELECT current_setting('server_version') AS v"
      );
      expect(ver[0].v.startsWith("17")).toBe(true); // new run-ops really is the dedicated box
      await cpWriter.$disconnect();
      await topo.legacyRunOps.writer.$disconnect();
      await topo.newRunOps.writer.$disconnect();
    } finally {
      await rds.stop();
      await ps.stop();
    }
  }, 120_000);

  it("split ON + legacySharesControlPlane: legacy reuses the CP pool, only the new DB opens a client", async () => {
    const rds = await new PostgreSqlContainer("docker.io/postgres:14").start();
    const ps = await new PostgreSqlContainer("docker.io/postgres:17").start();
    try {
      const cpWriter = buildWriterClient({ url: rds.getConnectionUri(), clientType: "cp" });
      const cp = { writer: cpWriter, replica: cpWriter };
      const legacyBuilds: string[] = [];
      const topo = selectRunOpsTopology(
        {
          splitEnabled: true,
          legacyUrl: rds.getConnectionUri(),
          legacyReplicaUrl: rds.getConnectionUri(),
          newUrl: ps.getConnectionUri(),
          legacySharesControlPlane: true,
        },
        {
          controlPlane: cp,
          buildNewWriter: (url, ct) => buildWriterClient({ url, clientType: ct }) as any,
          buildNewReplica: (url, ct) => buildReplicaClient({ url, clientType: ct }) as any,
          buildLegacyWriter: (url, ct) => {
            legacyBuilds.push(url);
            return buildWriterClient({ url, clientType: ct });
          },
          buildLegacyReplica: (url, ct) => {
            legacyBuilds.push(url);
            return buildReplicaClient({ url, clientType: ct });
          },
        }
      );
      expect(legacyBuilds).toHaveLength(0); // no redundant legacy pool against the shared server
      expect(topo.legacyRunOps).toBe(cp);
      expect(topo.legacyRunOps.writer).toBe(cpWriter);
      expect(topo.newRunOps.writer).not.toBe(cpWriter);
      await topo.legacyRunOps.writer.$queryRawUnsafe("SELECT 1"); // legacy queries run on the CP pool
      await topo.newRunOps.writer.$queryRawUnsafe("SELECT 1");
      await cpWriter.$disconnect();
      await topo.newRunOps.writer.$disconnect();
    } finally {
      await rds.stop();
      await ps.stop();
    }
  }, 120_000);
});

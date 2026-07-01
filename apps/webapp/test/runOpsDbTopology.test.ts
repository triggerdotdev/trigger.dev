import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it, vi } from "vitest";
import { buildReplicaClient, buildWriterClient, selectRunOpsTopology } from "~/db.server";

const cp = { writer: {} as any, replica: {} as any };

describe("selectRunOpsTopology (pure)", () => {
  it("split OFF: all run-ops handles collapse to control-plane and NO client is built", () => {
    const buildNewWriter = vi.fn();
    const buildNewReplica = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: false, legacyUrl: "postgres://a", newUrl: "postgres://b" },
      { controlPlane: cp, buildNewWriter, buildNewReplica }
    );
    // new run-ops collapses to the control-plane client refs (no second connection).
    expect(topo.newRunOps.writer).toBe(cp.writer);
    expect(topo.newRunOps.replica).toBe(cp.replica);
    expect(topo.legacyRunOps).toBe(cp);
    expect(topo.controlPlane).toBe(cp);
    expect(buildNewWriter).not.toHaveBeenCalled(); // no second connection opened
    expect(buildNewReplica).not.toHaveBeenCalled();
  });

  it("split ON: new-run-ops builds its own writer + replica; cp/legacy reuse cp", () => {
    const newWriter = { tag: "nw" } as any;
    const newReplica = { tag: "nr" } as any;
    const buildNewWriter = vi.fn().mockReturnValue(newWriter);
    const buildNewReplica = vi.fn().mockReturnValue(newReplica);
    const topo = selectRunOpsTopology(
      {
        splitEnabled: true,
        legacyUrl: "postgres://legacy",
        newUrl: "postgres://new",
        newReplicaUrl: "postgres://new-r",
      },
      { controlPlane: cp, buildNewWriter, buildNewReplica }
    );
    expect(topo.newRunOps.writer).toBe(newWriter);
    expect(topo.newRunOps.replica).toBe(newReplica);
    expect(topo.controlPlane).toBe(cp);
    expect(topo.legacyRunOps).toBe(cp); // legacy run-ops shares the control-plane server initially
    expect(buildNewWriter).toHaveBeenCalledTimes(1);
  });

  it("split ON without a new replica URL: replica falls back to the new writer", () => {
    const newWriter = { tag: "nw" } as any;
    const buildNewWriter = vi.fn().mockReturnValue(newWriter);
    const buildNewReplica = vi.fn();
    const topo = selectRunOpsTopology(
      { splitEnabled: true, legacyUrl: "postgres://legacy", newUrl: "postgres://new" },
      { controlPlane: cp, buildNewWriter, buildNewReplica }
    );
    expect(topo.newRunOps.replica).toBe(newWriter);
    expect(buildNewReplica).not.toHaveBeenCalled();
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
        }
      );
      expect(builtUrls).toHaveLength(0); // no second connection opened
      expect(topo.newRunOps.writer).toBe(cp.writer);
      expect(topo.newRunOps.replica).toBe(cp.replica);
      expect(topo.legacyRunOps).toBe(cp);
      await topo.newRunOps.writer.$queryRawUnsafe("SELECT 1");
      await cpWriter.$disconnect();
    } finally {
      await pg.stop();
    }
  }, 60_000);

  it("split ON: constructs CP + legacy-run-ops + new-run-ops + replicas (legacy + new)", async () => {
    const rds = await new PostgreSqlContainer("docker.io/postgres:14").start();
    const ps = await new PostgreSqlContainer("docker.io/postgres:17").start();
    try {
      const cpWriter = buildWriterClient({ url: rds.getConnectionUri(), clientType: "cp" });
      const cp = { writer: cpWriter, replica: cpWriter };
      const topo = selectRunOpsTopology(
        { splitEnabled: true, legacyUrl: rds.getConnectionUri(), newUrl: ps.getConnectionUri() },
        {
          controlPlane: cp,
          buildNewWriter: (url, ct) => buildWriterClient({ url, clientType: ct }) as any,
          buildNewReplica: (url, ct) => buildReplicaClient({ url, clientType: ct }) as any,
        }
      );
      // CP + legacy resolve to the legacy/control-plane pair; new run-ops is the dedicated run-ops box.
      expect(topo.controlPlane).toBe(cp);
      expect(topo.legacyRunOps).toBe(cp);
      expect(topo.newRunOps.writer).not.toBe(cpWriter);
      await topo.controlPlane.writer.$queryRawUnsafe("SELECT 1");
      await topo.newRunOps.writer.$queryRawUnsafe("SELECT 1");
      const ver = await topo.newRunOps.writer.$queryRawUnsafe<Array<{ v: string }>>(
        "SELECT current_setting('server_version') AS v"
      );
      expect(ver[0].v.startsWith("17")).toBe(true); // new run-ops really is the dedicated box
      await cpWriter.$disconnect();
      await topo.newRunOps.writer.$disconnect();
    } finally {
      await rds.stop();
      await ps.stop();
    }
  }, 120_000);
});

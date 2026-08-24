import { describe, expect, it } from "vitest";
import { resolveRunOpsPoolKnobs } from "~/v3/runOpsPoolKnobs.server";
import { env } from "~/env.server";

describe("resolveRunOpsPoolKnobs", () => {
  it("new role: reproduces the run-ops builder expressions and stdoutLogs is false", () => {
    const k = resolveRunOpsPoolKnobs("new");
    expect(k.connectionLimit).toBe(env.DATABASE_CONNECTION_LIMIT);
    expect(k.replicaConnectionLimit).toBe(
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_LIMIT ?? env.DATABASE_CONNECTION_LIMIT
    );
    expect(k.writerPoolTimeout).toBe(
      env.RUN_OPS_DATABASE_WRITER_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT
    );
    expect(k.replicaPoolTimeout).toBe(
      env.RUN_OPS_DATABASE_READ_REPLICA_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT
    );
    expect(k.writerDriverAdapter).toBe(env.RUN_OPS_DATABASE_WRITER_DRIVER_ADAPTER === "1");
    expect(k.replicaDriverAdapter).toBe(env.RUN_OPS_DATABASE_REPLICA_DRIVER_ADAPTER === "1");
    expect(k.stdoutLogs).toBe(false);
  });

  it("legacy role: uses RUN_OPS_LEGACY_* timeouts, generic connection limit, and stdoutLogs true", () => {
    const k = resolveRunOpsPoolKnobs("legacy");
    expect(k.stdoutLogs).toBe(true);
    expect(k.connectionLimit).toBe(env.DATABASE_CONNECTION_LIMIT);
    expect(k.replicaConnectionLimit).toBe(env.DATABASE_CONNECTION_LIMIT);
    expect(k.writerPoolTimeout).toBe(
      env.RUN_OPS_LEGACY_DATABASE_WRITER_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT
    );
    expect(k.replicaPoolTimeout).toBe(
      env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT
    );
    expect(k.writerDriverAdapter).toBe(env.RUN_OPS_LEGACY_DATABASE_WRITER_DRIVER_ADAPTER === "1");
    expect(k.replicaDriverAdapter).toBe(env.RUN_OPS_LEGACY_DATABASE_REPLICA_DRIVER_ADAPTER === "1");
  });

  it("a descriptor knob overrides its field", () => {
    const k = resolveRunOpsPoolKnobs("new", { connectionLimit: 7, writerDriverAdapter: true });
    expect(k.connectionLimit).toBe(7);
    expect(k.writerDriverAdapter).toBe(true);
  });

  it("descriptor knobs never override the role's stdoutLogs or label", () => {
    const k = resolveRunOpsPoolKnobs("new", { connectionLimit: 7 });
    expect(k.stdoutLogs).toBe(false);
    expect(k.label).toContain("run-ops");
  });
});

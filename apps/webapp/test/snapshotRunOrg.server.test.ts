import { describe, expect, it } from "vitest";
import { createSnapshotRunOrgSource } from "~/v3/snapshotRunOrg.server";

type Row = { runtimeEnvironment: { organizationId: string } } | null;

/** A hand-written fake standing in for the Prisma client, so no mocking is needed. */
function fakeClient(opts: {
  mapping?: Record<string, string>;
  reject?: boolean;
  delayMs?: number;
}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    taskRun: {
      async findFirst(args: { where: { id: string } }): Promise<Row> {
        calls++;
        if (opts.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        }
        if (opts.reject) {
          throw new Error("db unreachable");
        }
        const organizationId = opts.mapping?.[args.where.id];
        return organizationId ? { runtimeEnvironment: { organizationId } } : null;
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("snapshot run→org source", () => {
  it("resolve is a pure cache get: a cold miss is undefined and never queries", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary });

    expect(source.resolve("run_a")).toBeUndefined();

    await tick();

    // No off-path populate exists anymore, so a miss stays a miss and the DB is never touched.
    expect(source.resolve("run_a")).toBeUndefined();
    expect(primary.calls).toBe(0);
  });

  it("prime makes a later resolve a pure hit, with no query", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary });

    source.prime("run_a", "org_a");

    expect(source.resolve("run_a")).toBe("org_a");
    await tick();
    expect(primary.calls).toBe(0);
  });

  it("prime is idempotent and never queries, however many times it is called", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary });

    source.prime("run_a", "org_a");
    source.prime("run_a", "org_a");
    source.prime("run_a", "org_a");

    expect(source.resolve("run_a")).toBe("org_a");
    expect(primary.calls).toBe(0);
  });

  it("resolveAuthoritative returns the org id on success and caches it", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary });

    await expect(source.resolveAuthoritative("run_a")).resolves.toBe("org_a");
    expect(source.resolve("run_a")).toBe("org_a");
  });

  it("resolveAuthoritative serves a primed mapping without querying", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary });

    source.prime("run_a", "org_a");

    await expect(source.resolveAuthoritative("run_a")).resolves.toBe("org_a");
    expect(primary.calls).toBe(0);
  });

  it("resolveAuthoritative throws when the run has no organization", async () => {
    const primary = fakeClient({ mapping: {} });
    const source = createSnapshotRunOrgSource({ primary });

    await expect(source.resolveAuthoritative("run_missing")).rejects.toThrow();
  });

  it("resolveAuthoritative throws when the client rejects", async () => {
    const primary = fakeClient({ reject: true });
    const source = createSnapshotRunOrgSource({ primary });

    await expect(source.resolveAuthoritative("run_a")).rejects.toThrow();
  });

  it("resolveAuthoritative throws when the read exceeds the deadline", async () => {
    // Just over the 500 ms deadline: enough to trip it, without leaving a long timer running past
    // the rejection and holding the vitest worker open for the difference.
    const primary = fakeClient({ mapping: { run_a: "org_a" }, delayMs: 600 });
    const source = createSnapshotRunOrgSource({ primary });

    await expect(source.resolveAuthoritative("run_a")).rejects.toThrow(/deadline|exceed/i);
  });
});

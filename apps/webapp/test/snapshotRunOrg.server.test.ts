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
  it("returns undefined on a cold miss, then serves the org id once the populate settles", async () => {
    const replica = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary: replica, replica });

    expect(source.resolve("run_a")).toBeUndefined();

    await tick();

    expect(source.resolve("run_a")).toBe("org_a");
  });

  it("does not start a second populate while one is in flight", async () => {
    const replica = fakeClient({ mapping: { run_a: "org_a" }, delayMs: 20 });
    const source = createSnapshotRunOrgSource({ primary: replica, replica });

    source.resolve("run_a");
    source.resolve("run_a");
    source.resolve("run_a");

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(replica.calls).toBe(1);
    expect(source.resolve("run_a")).toBe("org_a");
  });

  it("resolveAuthoritative returns the org id on success and caches it", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" } });
    const source = createSnapshotRunOrgSource({ primary, replica: primary });

    await expect(source.resolveAuthoritative("run_a")).resolves.toBe("org_a");
    expect(source.resolve("run_a")).toBe("org_a");
  });

  it("resolveAuthoritative throws when the run has no organization", async () => {
    const primary = fakeClient({ mapping: {} });
    const source = createSnapshotRunOrgSource({ primary, replica: primary });

    await expect(source.resolveAuthoritative("run_missing")).rejects.toThrow();
  });

  it("resolveAuthoritative throws when the client rejects", async () => {
    const primary = fakeClient({ reject: true });
    const source = createSnapshotRunOrgSource({ primary, replica: primary });

    await expect(source.resolveAuthoritative("run_a")).rejects.toThrow();
  });

  it("resolveAuthoritative throws when the read exceeds the deadline", async () => {
    const primary = fakeClient({ mapping: { run_a: "org_a" }, delayMs: 2000 });
    const source = createSnapshotRunOrgSource({ primary, replica: primary });

    await expect(source.resolveAuthoritative("run_a")).rejects.toThrow(/deadline|exceed/i);
  });
});

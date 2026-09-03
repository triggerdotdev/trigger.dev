import { describe, expect, it } from "vitest";
import { createSnapshotRunOrgSource } from "~/v3/snapshotRunOrg.server";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("snapshot run→org source", () => {
  it("resolve is a pure cache get: a cold miss is undefined and never blocks", async () => {
    const source = createSnapshotRunOrgSource();

    expect(source.resolve("run_a")).toBeUndefined();

    await tick();

    // There is no off-path populate and no DB read, so a miss stays a miss for life.
    expect(source.resolve("run_a")).toBeUndefined();
  });

  it("prime makes a later resolve a pure hit", async () => {
    const source = createSnapshotRunOrgSource();

    source.prime("run_a", "org_a");

    expect(source.resolve("run_a")).toBe("org_a");
    await tick();
    expect(source.resolve("run_a")).toBe("org_a");
  });

  it("prime is idempotent, however many times it is called", () => {
    const source = createSnapshotRunOrgSource();

    source.prime("run_a", "org_a");
    source.prime("run_a", "org_a");
    source.prime("run_a", "org_a");

    expect(source.resolve("run_a")).toBe("org_a");
  });
});

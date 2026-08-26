import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { createSourceReadLedger } from "./tool-source-ledger";
import type { RepoSnapshot } from "./repo-tools";

const dirtySnapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "dededededededededededededededededededede",
  dirty: true,
};

const cleanSnapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
};

function fakeRepoTools(path: string): ToolSet {
  return {
    read_file: {
      execute: async () => ({ path, content: "..." }),
    },
  } as unknown as ToolSet;
}

describe("tool-source-ledger dirty propagation", () => {
  it("stamps a read at a dirty default snapshot as dirty", async () => {
    const ledger = createSourceReadLedger({
      origin: "http://unused.invalid",
      hasAuth: false,
      repoSnapshot: dirtySnapshot,
    });
    const tools = ledger.withReadTracking(fakeRepoTools("src/trigger/order.ts"));
    await tools.read_file!.execute!({ path: "src/trigger/order.ts" }, {} as any);

    expect(ledger.wasReadThisTurn("src/trigger/order.ts", dirtySnapshot.sha)).toBe(true);
    expect(ledger.dirtyForSha(dirtySnapshot.sha)).toBe(true);
  });

  it("leaves a read at a clean snapshot not dirty", async () => {
    const ledger = createSourceReadLedger({
      origin: "http://unused.invalid",
      hasAuth: false,
      repoSnapshot: cleanSnapshot,
    });
    const tools = ledger.withReadTracking(fakeRepoTools("src/trigger/order.ts"));
    await tools.read_file!.execute!({ path: "src/trigger/order.ts" }, {} as any);

    expect(ledger.dirtyForSha(cleanSnapshot.sha)).toBe(false);
  });

  it("reports not-dirty for a sha it has no record of", () => {
    const ledger = createSourceReadLedger({ origin: "http://unused.invalid", hasAuth: false });
    expect(ledger.dirtyForSha("unknown-sha")).toBe(false);
  });
});

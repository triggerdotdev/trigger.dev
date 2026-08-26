import type { ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("sticky dirty across a shared sha", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // A dirty run-pinned deploy can land on the exact same commit as the clean tracked
    // branch. A later clean read of that sha must not erase the caveat the dirty read
    // already earned — that's the exact fact-loss dirtyForSha exists to prevent.
    it("stays true once a dirty read has recorded a sha, even after a later clean read of the same sha", async () => {
      const sharedSha = "5ca5ca5ca5ca5ca5ca5ca5ca5ca5ca5ca5ca5ca5";
      const sharedShaSnapshot: RepoSnapshot = {
        tarballUrl: "http://unused.invalid/never-fetched",
        owner: "acme",
        repo: "demo",
        sha: sharedSha,
      };

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...sharedShaSnapshot, dirty: true }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const ledger = createSourceReadLedger({
        origin: "http://unused.invalid",
        hasAuth: true,
        userActorToken: "token",
        projectRef: "proj_1",
        environmentName: "dev",
        // The default snapshot: same sha, but clean.
        repoSnapshot: sharedShaSnapshot,
      });
      const tools = ledger.withReadTracking(fakeRepoTools("src/trigger/order.ts"));

      // Dirty read first, via the run-pinned resolver.
      await tools.read_file!.execute!(
        { path: "src/trigger/order.ts", runId: "run_dirty" },
        {} as any
      );
      expect(ledger.dirtyForSha(sharedSha)).toBe(true);

      // Clean read second, at the same sha, via the default snapshot.
      await tools.read_file!.execute!({ path: "src/trigger/order.ts" }, {} as any);
      expect(ledger.dirtyForSha(sharedSha)).toBe(true);
    });
  });
});

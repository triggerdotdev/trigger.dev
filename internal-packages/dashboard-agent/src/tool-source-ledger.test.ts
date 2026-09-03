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

/**
 * The source tools reach a run's commit through this fetch, so a run located in another
 * project/environment is only readable if the target travels with the run id.
 */
describe("the run-snapshot fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("addresses the target project, environment and branch", async () => {
    const urls: string[] = [];
    const branches: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any = {}) => {
        urls.push(typeof input === "string" ? input : input.url);
        branches.push(new Headers(init.headers ?? {}).get("x-trigger-branch"));
        return Response.json(cleanSnapshot);
      })
    );
    const ledger = createSourceReadLedger({
      origin: "https://api.example.com",
      hasAuth: true,
      userActorToken: "uat",
      projectRef: "proj_current",
      environmentName: "prod",
      environmentBranch: "chat-branch",
    });

    const snap = await ledger.resolveRunSnapshot("run_1", {
      projectRef: "proj_other",
      environmentName: "preview",
      branch: "feat/checkout",
    });

    expect(snap?.sha).toBe(cleanSnapshot.sha);
    expect(urls[0]).toBe(
      "https://api.example.com/api/v1/projects/proj_other/preview/repo/snapshot?runId=run_1"
    );
    expect(branches[0]).toBe("feat/checkout");
  });

  it("keeps the chat scope, branch included, when no target is given", async () => {
    const urls: string[] = [];
    const branches: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any = {}) => {
        urls.push(typeof input === "string" ? input : input.url);
        branches.push(new Headers(init.headers ?? {}).get("x-trigger-branch"));
        return Response.json(cleanSnapshot);
      })
    );
    const ledger = createSourceReadLedger({
      origin: "https://api.example.com",
      hasAuth: true,
      userActorToken: "uat",
      projectRef: "proj_current",
      environmentName: "preview",
      environmentBranch: "chat-branch",
    });

    await ledger.resolveRunSnapshot("run_1");

    expect(urls[0]).toBe(
      "https://api.example.com/api/v1/projects/proj_current/preview/repo/snapshot?runId=run_1"
    );
    expect(branches[0]).toBe("chat-branch");
  });
});

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

    // A later clean read of a sha must not erase the caveat a dirty read already earned:
    // that's the exact fact-loss dirtyForSha exists to prevent.
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

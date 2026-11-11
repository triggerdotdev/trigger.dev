import type { RunExecutionData } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideSnapshot,
  GuestSnapshotCleaner,
  snapshotsByRun,
  type GuestSnapshot,
} from "./guestSnapshotCleaner.js";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const MIN_AGE_MS = 30 * 60_000;
const OLD = new Date(NOW - 2 * MIN_AGE_MS).toISOString();
const YOUNG = new Date(NOW - MIN_AGE_MS / 2).toISOString();

function execution(
  executionStatus: RunExecutionData["snapshot"]["executionStatus"],
  checkpoint?: { type?: "COMPUTE" | "KUBERNETES" | "DOCKER"; location: string }
): RunExecutionData {
  return {
    version: "1",
    snapshot: {
      id: "snapshot_1",
      friendlyId: "snapshot_1",
      executionStatus,
      description: "test",
      createdAt: new Date(NOW),
    },
    run: { id: "run_1", friendlyId: "run_a", status: "EXECUTING" },
    checkpoint: checkpoint
      ? {
          id: "checkpoint_1",
          friendlyId: "checkpoint_1",
          type: checkpoint.type ?? "COMPUTE",
          location: checkpoint.location,
        }
      : undefined,
    completedWaitpoints: [],
  };
}

function snapshot(id: string, createdAt: string, run?: string): GuestSnapshot {
  return {
    snapshot_id: id,
    created_at: createdAt,
    labels: run ? { "trigger.dev/run": run, "trigger.dev/execution-snapshot": "snapshot_x" } : {},
  };
}

describe("guest snapshot cleaner", () => {
  describe("snapshotsByRun", () => {
    // Catches: deleting templates, boot snapshots or snapshots a suspend may still be submitting.
    it("takes only labelled snapshots past the minimum age, grouped by run", () => {
      const byRun = snapshotsByRun(
        [
          snapshot("snap-old-a1", OLD, "run_a"),
          snapshot("snap-old-a2", OLD, "run_a"),
          snapshot("snap-old-b", OLD, "run_b"),
          snapshot("snap-young", YOUNG, "run_a"),
          snapshot("snap-unlabelled", OLD),
          { snapshot_id: "snap-template", created_at: OLD, labels: null },
          snapshot("snap-bad-date", "not a date", "run_a"),
        ],
        NOW,
        MIN_AGE_MS
      );
      expect(Object.fromEntries(byRun)).toEqual({
        run_a: ["snap-old-a1", "snap-old-a2"],
        run_b: ["snap-old-b"],
      });
    });
  });

  describe("decideSnapshot", () => {
    // Catches: keeping snapshots of finished runs forever, which fills the node's disk.
    it("deletes a finished run's snapshots, whatever its last checkpoint", () => {
      expect(decideSnapshot("snap-1", execution("FINISHED"))).toEqual({
        action: "delete",
        reason: "finished",
      });
      expect(
        decideSnapshot("snap-1", execution("FINISHED", { location: "node-a/snap-1" }))
      ).toEqual({ action: "delete", reason: "finished" });
    });

    // Catches: comparing against the whole <node>/<snapshot> location, which never matches.
    it("deletes a snapshot superseded by a later checkpoint and keeps the current one", () => {
      expect(
        decideSnapshot("snap-1", execution("SUSPENDED", { location: "node-a/snap-2" }))
      ).toEqual({ action: "delete", reason: "superseded" });
      expect(
        decideSnapshot("snap-2", execution("SUSPENDED", { location: "node-a/snap-2" }))
      ).toEqual({ action: "keep", reason: "alive" });
      expect(decideSnapshot("snap-2", execution("QUEUED", { location: "node-a/snap-2" }))).toEqual({
        action: "keep",
        reason: "alive",
      });
    });

    // Catches: deleting the snapshot a resumed run was just restored from.
    it("keeps a live run's snapshots while its latest execution snapshot has no checkpoint", () => {
      expect(decideSnapshot("snap-1", execution("EXECUTING"))).toEqual({
        action: "keep",
        reason: "alive",
      });
      expect(decideSnapshot("snap-1", execution("PENDING_CANCEL"))).toEqual({
        action: "keep",
        reason: "alive",
      });
    });

    // Catches: a failed lookup or an unfamiliar checkpoint being read as permission to delete.
    it("keeps the snapshot when the run cannot be read or its checkpoint is unexpected", () => {
      expect(decideSnapshot("snap-1", undefined)).toEqual({
        action: "keep",
        reason: "lookup_error",
      });
      expect(
        decideSnapshot(
          "snap-1",
          execution("SUSPENDED", { type: "KUBERNETES", location: "node-a/snap-2" })
        )
      ).toEqual({ action: "keep", reason: "unexpected" });
      expect(decideSnapshot("snap-1", execution("SUSPENDED", { location: "snap-2" }))).toEqual({
        action: "keep",
        reason: "unexpected",
      });
    });
  });

  describe("runPass", () => {
    const servers: Server[] = [];
    const dirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
      );
      await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    });

    async function listen(handler: Parameters<typeof createServer>[1]) {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    /** A node proxy listing `snapshots` and answering deletes with `deleteStatus`. */
    async function nodeProxy(
      snapshots: GuestSnapshot[] | { status: number },
      deleteStatus: (id: string) => number = () => 200,
      defaultLimit = 1000
    ) {
      const requests: { method?: string; url?: string; authorization?: string }[] = [];
      const url = await listen((req, res) => {
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
        });
        const listing = new URL(req.url ?? "", "http://proxy");
        if (req.method === "GET" && listing.pathname === "/snapshots") {
          if (!Array.isArray(snapshots)) {
            res.writeHead(snapshots.status).end("no");
            return;
          }
          const limit = Number(listing.searchParams.get("limit")) || defaultLimit;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              snapshots: snapshots.slice(0, limit),
              truncated: snapshots.length > limit,
            })
          );
          return;
        }
        const id = decodeURIComponent(req.url?.replace("/snapshots/", "") ?? "");
        res.writeHead(deleteStatus(id)).end();
      });
      return { url, requests, deletes: () => requests.filter((r) => r.method === "DELETE") };
    }

    /** A worker API answering each run's latest snapshot from `runs`, 500 for any other. */
    async function workerApi(runs: Record<string, RunExecutionData>) {
      const url = await listen((req, res) => {
        const runId = /\/runs\/([^/]+)\/snapshots\/latest$/.exec(req.url ?? "")?.[1];
        const found = runId ? runs[runId] : undefined;
        if (!found) {
          res.writeHead(500, { "x-should-retry": "false", "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to retrieve latest snapshot" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution: found }));
      });
      return new SupervisorHttpClient({
        apiUrl: url,
        workerToken: "tr_wgt_test",
        instanceName: "test",
      });
    }

    async function tokenFile(contents: string | undefined) {
      const dir = await mkdtemp(join(tmpdir(), "guest-snapshot-cleaner-"));
      dirs.push(dir);
      const path = join(dir, "token");
      if (contents !== undefined) {
        await writeFile(path, contents);
      }
      return path;
    }

    function cleaner(nodeProxyUrl: string, tokenPath: string, client: SupervisorHttpClient) {
      return new GuestSnapshotCleaner({
        nodeProxyUrl,
        tokenPath,
        minAgeMs: MIN_AGE_MS,
        intervalMs: 60_000,
        client: () => client,
        register: new Registry(),
      });
    }

    const old = new Date(Date.now() - 2 * MIN_AGE_MS).toISOString();

    // Catches: the decision not reaching the node proxy, or deletes going out without the token.
    it("deletes finished and superseded snapshots and keeps the rest", async () => {
      const proxy = await nodeProxy(
        [
          snapshot("snap-finished", old, "run_finished"),
          snapshot("snap-superseded", old, "run_suspended"),
          snapshot("snap-current", old, "run_suspended"),
          snapshot("snap-alive", old, "run_executing"),
          snapshot("snap-unknown", old, "run_unknown"),
          snapshot("snap-held", old, "run_held"),
          snapshot("snap-gone", old, "run_gone"),
          snapshot("snap-young", new Date().toISOString(), "run_finished"),
          snapshot("snap-template", old),
        ],
        (id) => (id === "snap-held" ? 409 : id === "snap-gone" ? 404 : 200)
      );
      const client = await workerApi({
        run_finished: execution("FINISHED"),
        run_suspended: execution("SUSPENDED", { location: "node-a/snap-current" }),
        run_executing: execution("EXECUTING"),
        run_held: execution("FINISHED"),
        run_gone: execution("FINISHED"),
      });

      const summary = await cleaner(proxy.url, await tokenFile("sa-token\n"), client).runPass();

      expect(summary).toEqual({
        deleted: 2,
        held: 1,
        not_found: 1,
        kept_alive: 2,
        kept_lookup_error: 1,
      });
      expect(
        proxy
          .deletes()
          .map((r) => r.url)
          .sort()
      ).toEqual([
        "/snapshots/snap-finished",
        "/snapshots/snap-gone",
        "/snapshots/snap-held",
        "/snapshots/snap-superseded",
      ]);
      expect(proxy.requests.every((r) => r.authorization === "Bearer sa-token")).toBe(true);
    });

    // Catches: a retained prefix of the default listing hiding reclaimable snapshots after it.
    it("lists past the daemon's default limit", async () => {
      const proxy = await nodeProxy(
        [
          snapshot("snap-a", old, "run_executing"),
          snapshot("snap-b", old, "run_executing"),
          snapshot("snap-c", old, "run_finished"),
        ],
        () => 200,
        2
      );
      const client = await workerApi({
        run_executing: execution("EXECUTING"),
        run_finished: execution("FINISHED"),
      });

      const summary = await cleaner(proxy.url, await tokenFile("sa-token"), client).runPass();

      expect(summary).toEqual({ deleted: 1, kept_alive: 2 });
      expect(proxy.deletes().map((r) => r.url)).toEqual(["/snapshots/snap-c"]);
    });

    // Catches: a pass deleting on a failed listing, or going ahead without its token.
    it("deletes nothing when the listing fails or the token cannot be read", async () => {
      const client = await workerApi({ run_finished: execution("FINISHED") });

      const failing = await nodeProxy({ status: 503 });
      expect(await cleaner(failing.url, await tokenFile("sa-token"), client).runPass()).toEqual({
        list_error: 1,
      });
      expect(failing.deletes()).toEqual([]);

      const listing = await nodeProxy([snapshot("snap-finished", old, "run_finished")]);
      for (const token of [undefined, "  \n"]) {
        expect(await cleaner(listing.url, await tokenFile(token), client).runPass()).toEqual({
          token_error: 1,
        });
      }
      expect(listing.requests).toEqual([]);
    });
  });
});

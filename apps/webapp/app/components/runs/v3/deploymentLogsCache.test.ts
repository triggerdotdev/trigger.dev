import { describe, expect, it } from "vitest";
import { DeploymentLogsCache, type DeploymentLogEntry } from "./deploymentLogsCache";

function lines(count: number): DeploymentLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    message: `line ${i}`,
    timestamp: new Date(0),
    level: "info" as const,
  }));
}

describe("DeploymentLogsCache", () => {
  it("returns undefined for unknown keys", () => {
    const cache = new DeploymentLogsCache(2, 100);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and returns entries", () => {
    const cache = new DeploymentLogsCache(2, 100);
    const value = { logs: lines(3), nextSeqNum: 3, finalized: true, complete: true };
    cache.set("a", value);
    expect(cache.get("a")).toBe(value);
    expect(cache.size).toBe(1);
    expect(cache.lineCount).toBe(3);
  });

  it("evicts the least recently used deployment past the entry limit", () => {
    const cache = new DeploymentLogsCache(2, 100);
    cache.set("a", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });
    cache.set("b", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });
    cache.get("a");
    cache.set("c", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("evicts oldest deployments past the total line budget", () => {
    const cache = new DeploymentLogsCache(10, 10);
    cache.set("a", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });
    cache.set("b", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });
    cache.set("c", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.lineCount).toBe(8);
  });

  it("always keeps the entry just set, even when it alone exceeds the budget", () => {
    const cache = new DeploymentLogsCache(10, 10);
    cache.set("a", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });
    cache.set("big", { logs: lines(50), nextSeqNum: 50, finalized: true, complete: true });

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("big")?.logs).toHaveLength(50);
    expect(cache.size).toBe(1);
    expect(cache.lineCount).toBe(50);
  });

  it("treats replacing a key as a recent use", () => {
    const cache = new DeploymentLogsCache(2, 100);
    cache.set("a", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });
    cache.set("b", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });
    cache.set("a", { logs: lines(2), nextSeqNum: 2, finalized: true, complete: true });
    cache.set("c", { logs: lines(1), nextSeqNum: 1, finalized: false, complete: false });

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.logs).toHaveLength(2);
    expect(cache.get("c")).toBeDefined();
  });

  it("keeps recently read deployments when evicting for the line budget", () => {
    const cache = new DeploymentLogsCache(10, 10);
    cache.set("a", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });
    cache.set("b", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });
    cache.get("a");
    cache.set("c", { logs: lines(4), nextSeqNum: 4, finalized: true, complete: true });

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.lineCount).toBe(8);
  });

  it("replaces an existing key without double counting lines", () => {
    const cache = new DeploymentLogsCache(10, 100);
    cache.set("a", { logs: lines(4), nextSeqNum: 4, finalized: false, complete: false });
    cache.set("a", { logs: lines(6), nextSeqNum: 6, finalized: true, complete: true });

    expect(cache.size).toBe(1);
    expect(cache.lineCount).toBe(6);
    expect(cache.get("a")?.complete).toBe(true);
  });
});

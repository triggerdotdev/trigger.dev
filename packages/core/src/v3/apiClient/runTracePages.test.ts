import { describe, expect, it } from "vitest";
import type { RetrieveRunTracePageSpan } from "../schemas/api.js";
import { assembleRunTracePages, type RunTraceNode } from "./runTracePages.js";

const BASE = new Date("2026-09-01T10:00:00.000Z").getTime();
const MS = 1_000_000;

function span(
  overrides: Partial<RetrieveRunTracePageSpan> & { id: string; offsetMs?: number }
): RetrieveRunTracePageSpan {
  const { offsetMs = 0, ...rest } = overrides;
  return {
    runId: "run_1",
    message: overrides.id,
    startTime: new Date(BASE + offsetMs),
    duration: 0,
    isError: false,
    isPartial: false,
    isCancelled: false,
    level: "TRACE",
    ...rest,
  };
}

function byId(roots: RunTraceNode[]): (id: string) => RunTraceNode {
  const out = new Map<string, RunTraceNode>();
  const walk = (node: RunTraceNode) => {
    out.set(node.id, node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return (id) => {
    const node = out.get(id);
    if (!node) throw new Error(`no span ${id}`);
    return node;
  };
}

function ids(roots: RunTraceNode[]): string[] {
  const out: string[] = [];
  const walk = (node: RunTraceNode) => {
    out.push(node.id);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

describe("assembleRunTracePages", () => {
  it("builds the tree across pages", () => {
    const roots = assembleRunTracePages([
      {
        data: [span({ id: "root" }), span({ id: "a", parentId: "root", offsetMs: 1 })],
        attemptFailures: [],
      },
      { data: [span({ id: "b", parentId: "a", offsetMs: 2 })], attemptFailures: [] },
    ]);

    expect(roots.map((r) => r.id)).toEqual(["root"]);
    expect(roots[0]!.children[0]!.id).toBe("a");
    expect(roots[0]!.children[0]!.children[0]!.id).toBe("b");
  });

  it("cancels a partial span under a cancelled ancestor, ending it with the ancestor", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isCancelled: true, duration: 10_000 * MS }),
            span({ id: "child", parentId: "root", offsetMs: 2_000, isPartial: true }),
          ],
          attemptFailures: [],
        },
      ])
    );

    expect(nodes("child")).toMatchObject({
      isCancelled: true,
      isPartial: false,
      isError: false,
      duration: 8_000 * MS,
    });
  });

  it("errors a partial span when the ancestor failed its attempt, even from a later page", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isError: true, duration: 5_000 * MS }),
            span({
              id: "attempt",
              parentId: "root",
              runId: "run_1",
              offsetMs: 1_000,
              isPartial: true,
              attemptNumber: 2,
            }),
          ],
          attemptFailures: [],
        },
        { data: [], attemptFailures: [{ spanId: "root", attemptNumber: 2, runId: "run_1" }] },
      ])
    );

    expect(nodes("attempt")).toMatchObject({
      isError: true,
      isPartial: false,
      duration: 4_000 * MS,
    });
  });

  it("carries a failed attempt down to nested unfinished spans of the same attempt", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isError: true, duration: 5_000 * MS }),
            span({ id: "child", parentId: "root", offsetMs: 1, isPartial: true, attemptNumber: 1 }),
            span({ id: "leaf", parentId: "child", offsetMs: 2, isPartial: true, attemptNumber: 1 }),
            span({
              id: "other",
              parentId: "child",
              offsetMs: 3,
              isPartial: true,
              attemptNumber: 2,
            }),
          ],
          attemptFailures: [{ spanId: "root", attemptNumber: 1, runId: "run_1" }],
        },
      ])
    );

    expect(nodes("child")).toMatchObject({ isError: true, isPartial: false });
    expect(nodes("leaf")).toMatchObject({ isError: true, isPartial: false });
    expect(nodes("other")).toMatchObject({ isError: false, isPartial: true });
  });

  it("ignores a failure for another attempt or run", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isError: true, duration: 5_000 * MS }),
            span({ id: "a", parentId: "root", isPartial: true, attemptNumber: 1, runId: "run_1" }),
          ],
          attemptFailures: [
            { spanId: "root", attemptNumber: 2, runId: "run_1" },
            { spanId: "root", attemptNumber: 1, runId: "run_other" },
          ],
        },
      ])
    );

    expect(nodes("a")).toMatchObject({ isError: false, isPartial: true });
  });

  it("leaves finished spans, logs and spans without a finished ancestor alone", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isCancelled: true, duration: 5_000 * MS }),
            span({ id: "done", parentId: "root", duration: 1 * MS }),
            span({ id: "log", parentId: "root", level: "INFO", isPartial: true }),
            span({ id: "running-root", offsetMs: 10, isPartial: true }),
            span({ id: "orphan", parentId: "running-root", offsetMs: 11, isPartial: true }),
          ],
          attemptFailures: [],
        },
      ])
    );

    expect(nodes("done")).toMatchObject({ isCancelled: false, isPartial: false, duration: 1 * MS });
    expect(nodes("log")).toMatchObject({ isCancelled: false, isPartial: true });
    expect(nodes("orphan")).toMatchObject({ isCancelled: false, isPartial: true });
  });

  it("keeps one copy of a span repeated across pages, in its finished state", () => {
    const partial = span({ id: "a", parentId: "root", offsetMs: 2, isPartial: true, message: "a" });
    const finished = span({
      id: "a",
      parentId: "root",
      offsetMs: 1,
      duration: 7 * MS,
      isError: true,
      message: "a",
      attemptNumber: 3,
    });
    const root = span({ id: "root", duration: 10 * MS });

    const orders: Array<[RetrieveRunTracePageSpan, RetrieveRunTracePageSpan]> = [
      [partial, finished],
      [finished, partial],
    ];
    for (const [first, second] of orders) {
      const roots = assembleRunTracePages([
        { data: [root, first], attemptFailures: [] },
        { data: [second], attemptFailures: [] },
      ]);

      expect(roots[0]!.children).toHaveLength(1);
      expect(roots[0]!.children[0]).toMatchObject({
        id: "a",
        isPartial: false,
        isError: true,
        duration: 7 * MS,
        attemptNumber: 3,
        startTime: new Date(BASE + 1),
      });
    }
  });

  it("never gives a negative duration to a span that started after its ancestor ended", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isCancelled: true, duration: 1_000 * MS }),
            span({ id: "late", parentId: "root", offsetMs: 30_000, isPartial: true }),
          ],
          attemptFailures: [],
        },
      ])
    );

    expect(nodes("late")).toMatchObject({ isCancelled: true, isPartial: false, duration: 0 });
  });

  it("survives a parent loop: no hang, and looped spans become roots", () => {
    const roots = assembleRunTracePages([
      {
        data: [
          span({ id: "root", isCancelled: true, duration: 10 * MS }),
          span({ id: "a", parentId: "b", offsetMs: 1, isPartial: true }),
          span({ id: "b", parentId: "a", offsetMs: 2, isPartial: true }),
          span({ id: "self", parentId: "self", offsetMs: 3, isPartial: true }),
          span({ id: "underLoop", parentId: "a", offsetMs: 4, isPartial: true }),
        ],
        attemptFailures: [],
      },
    ]);

    const nodes = byId(roots);
    expect(ids(roots).sort()).toEqual(["a", "b", "root", "self", "underLoop"]);
    expect(roots.map((r) => r.id)).toEqual(["root", "a", "b", "self"]);
    expect(nodes("a").children.map((c) => c.id)).toEqual(["underLoop"]);
    expect(nodes("a").isPartial).toBe(true);
  });

  it("orders siblings by start time whatever order the pages arrive in", () => {
    const pageA = {
      data: [span({ id: "root" }), span({ id: "late", parentId: "root", offsetMs: 5 })],
      attemptFailures: [],
    };
    const pageB = {
      data: [span({ id: "early", parentId: "root", offsetMs: 1 })],
      attemptFailures: [],
    };

    for (const pages of [
      [pageA, pageB],
      [pageB, pageA],
    ]) {
      const roots = assembleRunTracePages(pages);
      expect(roots[0]!.children.map((c) => c.id)).toEqual(["early", "late"]);
    }
  });

  it("walks past partial ancestors to the nearest finished one", () => {
    const nodes = byId(
      assembleRunTracePages([
        {
          data: [
            span({ id: "root", isCancelled: true, duration: 10_000 * MS }),
            span({ id: "mid", parentId: "root", offsetMs: 1, isPartial: true }),
            span({ id: "leaf", parentId: "mid", offsetMs: 2, isPartial: true }),
          ],
          attemptFailures: [],
        },
      ])
    );

    expect(nodes("mid").isCancelled).toBe(true);
    expect(nodes("leaf").isCancelled).toBe(true);
  });
});

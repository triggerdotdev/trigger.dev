import { describe, expect, it } from "vitest";
import { SessionChannelRouter } from "./router.js";
import type { SessionRouteTable } from "./router.js";
import type { SessionStreamRecord } from "./types.js";

type Chunk = { kind: string; text?: string };

const CHAT_TABLE: SessionRouteTable = {
  kindOf: (data) => (data as Chunk | undefined)?.kind,
  routes: [
    { name: "messages", delivery: "queue", replayable: true, kinds: ["message"] },
    { name: "stop", delivery: "at-arrival", replayable: false, kinds: ["stop"] },
    {
      name: "handover",
      delivery: "queue",
      replayable: false,
      kinds: ["handover", "handover-skip"],
    },
  ],
};

function router(onDrop?: Parameters<typeof makeRouter>[0]) {
  return makeRouter(onDrop);
}

function makeRouter(
  onDrop?: (record: SessionStreamRecord, reason: string, route?: string) => void
) {
  return new SessionChannelRouter(CHAT_TABLE, { onDrop });
}

function rec(seqNum: number, kind: string, text?: string): SessionStreamRecord {
  return { id: `r${seqNum}`, seqNum, data: { kind, ...(text ? { text } : {}) } };
}

describe("SessionChannelRouter: table validation", () => {
  it("rejects a route that is at-arrival and replayable", () => {
    expect(
      () =>
        new SessionChannelRouter({
          kindOf: () => "x",
          routes: [{ name: "bad", delivery: "at-arrival", replayable: true, kinds: ["x"] }],
        })
    ).toThrow(/at-arrival and replayable/);
  });

  it("rejects a kind claimed by two routes", () => {
    expect(
      () =>
        new SessionChannelRouter({
          kindOf: () => "x",
          routes: [
            { name: "a", delivery: "queue", replayable: true, kinds: ["x"] },
            { name: "b", delivery: "queue", replayable: false, kinds: ["x"] },
          ],
        })
    ).toThrow(/claimed by both/);
  });
});

describe("SessionChannelRouter: classification", () => {
  it("queues a message when nobody is ready for it", () => {
    const r = router();
    expect(r.ingest(rec(0, "message", "M0"))).toEqual({ action: "queue", route: "messages" });
    expect(r.hasPending("messages")).toBe(true);
  });

  it("discards a stop with no handler attached", () => {
    const r = router();
    expect(r.ingest(rec(0, "stop"))).toEqual({
      action: "drop",
      route: "stop",
      reason: "no-handler",
    });
  });

  it("delivers a stop to a live handler", () => {
    const r = router();
    const seen: number[] = [];
    r.on("stop", (record) => seen.push(record.seqNum));
    expect(r.ingest(rec(3, "stop"))).toEqual({ action: "deliver", route: "stop" });
    expect(seen).toEqual([3]);
  });

  it("drops a kind no route claims, and reports it once", () => {
    const drops: Array<[number, string]> = [];
    const r = router((record, reason) => drops.push([record.seqNum, reason]));
    expect(r.ingest(rec(1, "some-future-kind"))).toEqual({
      action: "drop",
      reason: "unroutable",
    });
    expect(drops).toEqual([[1, "unroutable"]]);
  });

  it("drops a record with no usable kind", () => {
    const r = router();
    expect(r.ingest({ id: "x", seqNum: 0, data: { nope: true } })).toEqual({
      action: "drop",
      reason: "malformed",
    });
  });

  it("does not let a throwing kindOf take the channel down", () => {
    const r = new SessionChannelRouter({
      kindOf: () => {
        throw new Error("boom");
      },
      routes: [{ name: "m", delivery: "queue", replayable: true, kinds: ["message"] }],
    });
    expect(r.ingest(rec(0, "message"))).toEqual({ action: "drop", reason: "malformed" });
  });
});

describe("SessionChannelRouter: the wedge cannot happen", () => {
  it("delivers a message queued behind an unroutable record", async () => {
    const r = router();
    r.ingest(rec(0, "mystery-kind"));
    r.ingest(rec(1, "message", "M1"));

    expect(r.hasPending("messages")).toBe(true);
    const taken = await r.next("messages", { timeoutMs: 0 });
    expect((taken!.data as Chunk).text).toBe("M1");
  });

  it("reports pending for a message queued behind a stop", () => {
    const r = router();
    r.ingest(rec(0, "stop"));
    r.ingest(rec(1, "message", "M1"));

    expect(r.hasPending("messages")).toBe(true);
    expect((r.peek("messages")!.data as Chunk).text).toBe("M1");
  });
});

describe("SessionChannelRouter: delivery ordering", () => {
  it("serves a parked waiter before a push handler", async () => {
    const r = router();
    const handlerSaw: string[] = [];
    const pending = r.next("messages");
    r.on("messages", (record) => handlerSaw.push((record.data as Chunk).text!));

    r.ingest(rec(0, "message", "M0"));

    expect((await pending)?.seqNum).toBe(0);
    expect(handlerSaw).toEqual([]);
  });

  it("re-offers a queued record to a handler attaching later, in order", () => {
    const r = router();
    r.ingest(rec(0, "message", "M0"));
    r.ingest(rec(1, "message", "M1"));

    const seen: string[] = [];
    r.on("messages", (record) => seen.push((record.data as Chunk).text!));

    expect(seen).toEqual(["M0", "M1"]);
    expect(r.hasPending("messages")).toBe(false);
  });

  it("resolves next() undefined on timeout without consuming anything", async () => {
    const r = router();
    expect(await r.next("messages", { timeoutMs: 5 })).toBeUndefined();
    r.ingest(rec(0, "message", "M0"));
    expect((await r.next("messages", { timeoutMs: 0 }))?.seqNum).toBe(0);
  });
});

describe("SessionChannelRouter: the resume floor", () => {
  it("sits at the high water when nothing is owed", () => {
    const r = router();
    r.on("stop", () => {});
    r.ingest(rec(0, "message"));
    r.next("messages", { timeoutMs: 0 });
    r.ingest(rec(1, "stop"));

    expect(r.resumeFloor()).toBe(1);
    expect(r.appliedThrough()).toBe(1);
  });

  it("is held below a message still queued, even as control records advance", () => {
    const r = router();
    r.on("stop", () => {});
    r.ingest(rec(0, "message", "M0"));
    r.ingest(rec(1, "message", "M1"));
    r.next("messages", { timeoutMs: 0 });
    r.ingest(rec(2, "stop"));
    r.ingest(rec(3, "stop"));

    expect(r.resumeFloor()).toBe(0);
    expect(r.appliedThrough()).toBe(3);
  });

  it("is undefined rather than negative when the very first record is owed", () => {
    const r = router();
    r.ingest(rec(0, "message", "M0"));
    expect(r.resumeFloor()).toBeUndefined();
  });

  it("is not held back by a queued non-replayable record", () => {
    const r = router();
    r.ingest(rec(0, "handover"));
    r.ingest(rec(1, "message", "M1"));
    r.next("messages", { timeoutMs: 0 });

    expect(r.pendingCount("handover")).toBe(1);
    expect(r.resumeFloor()).toBe(1);
  });

  it("advances once the owed message is taken", async () => {
    const r = router();
    r.on("stop", () => {});
    r.ingest(rec(0, "message", "M0"));
    r.ingest(rec(1, "stop"));
    expect(r.resumeFloor()).toBeUndefined();

    await r.next("messages", { timeoutMs: 0 });
    expect(r.resumeFloor()).toBe(1);
  });

  it("tracks the earliest of several owed messages", () => {
    const r = router();
    r.ingest(rec(0, "message", "M0"));
    r.ingest(rec(1, "message", "M1"));
    r.ingest(rec(2, "message", "M2"));
    r.next("messages", { timeoutMs: 0 });

    expect(r.resumeFloor()).toBe(0);
    expect(r.appliedThrough()).toBe(2);
  });
});

describe("SessionChannelRouter: resuming", () => {
  it("does not apply a non-replayable record inside the replay window", () => {
    const r = router();
    r.restore({ resumeFrom: 0, appliedThrough: 2 });
    const stops: number[] = [];
    r.on("stop", (record) => stops.push(record.seqNum));

    expect(r.ingest(rec(1, "message", "M1"))).toEqual({ action: "queue", route: "messages" });
    expect(r.ingest(rec(2, "stop"))).toEqual({
      action: "drop",
      route: "stop",
      reason: "replayed",
    });
    expect(stops).toEqual([]);
  });

  it("applies the same kind arriving live, past the window", () => {
    const r = router();
    r.restore({ resumeFrom: 0, appliedThrough: 2 });
    const stops: number[] = [];
    r.on("stop", (record) => stops.push(record.seqNum));

    r.ingest(rec(1, "message", "M1"));
    r.ingest(rec(2, "stop"));
    expect(r.ingest(rec(3, "stop"))).toEqual({ action: "deliver", route: "stop" });
    expect(stops).toEqual([3]);
  });

  it("falls back to the floor when no replay-window end is supplied", () => {
    const r = router();
    r.restore({ resumeFrom: 4 });
    r.on("stop", () => {});

    expect(r.ingest(rec(4, "stop")).action).toBe("drop");
    expect(r.ingest(rec(5, "stop"))).toEqual({ action: "deliver", route: "stop" });
  });

  it("declines a control record inside a window resolved from the channel", () => {
    const r = router();
    // What the chat layer supplies when the boundary predates the published
    // window: everything already on the channel at boot counts as replayed.
    r.restore({ resumeFrom: 4, appliedThrough: 6 });
    const stops: number[] = [];
    r.on("stop", (record) => stops.push(record.seqNum));

    expect(r.ingest(rec(5, "message", "M5"))).toEqual({ action: "queue", route: "messages" });
    expect(r.ingest(rec(6, "stop"))).toEqual({
      action: "drop",
      route: "stop",
      reason: "replayed",
    });
    expect(r.ingest(rec(7, "stop"))).toEqual({ action: "deliver", route: "stop" });
    expect(stops).toEqual([7]);
  });

  it("applies everything on a fresh session with no checkpoint", () => {
    const r = router();
    r.on("stop", () => {});
    expect(r.ingest(rec(0, "stop"))).toEqual({ action: "deliver", route: "stop" });
  });

  it("never drops a replayable record, however far inside the window", () => {
    const r = router();
    r.restore({ resumeFrom: 0, appliedThrough: 9 });
    expect(r.ingest(rec(1, "message", "M1"))).toEqual({ action: "queue", route: "messages" });
  });

  it("keeps the floor from moving backwards past the restored point", () => {
    const r = router();
    r.restore({ resumeFrom: 7, appliedThrough: 7 });
    expect(r.resumeFloor()).toBe(7);
  });
});

describe("SessionChannelRouter: consumer windows", () => {
  it("queues a handover that arrives before its consumer is ready", async () => {
    const r = router();
    expect(r.ingest(rec(0, "handover")).action).toBe("queue");

    const taken = await r.next("handover", { timeoutMs: 0 });
    expect(taken?.seqNum).toBe(0);
  });

  it("discards what is left on a route when its window closes", () => {
    const r = router();
    r.ingest(rec(0, "handover"));
    r.clearRoute("handover");

    expect(r.pendingCount("handover")).toBe(0);
    expect(r.resumeFloor()).toBe(0);
  });

  it("wakes a waiter empty when its window closes", async () => {
    const r = router();
    const pending = r.next("handover");
    r.clearRoute("handover");
    expect(await pending).toBeUndefined();
  });
});

/**
 * The invariant the whole design exists to hold: across any interleaving and
 * any crash point, a message is delivered exactly once and a stop is never
 * applied twice.
 *
 * Runs every record sequence over a simulated two-boot lifecycle. The second
 * boot resubscribes from the published floor, exactly as the tail does with
 * `Last-Event-ID`, so a floor that is too high shows up as a lost message and
 * one that replays a stop shows up as a duplicate application.
 */
describe("SessionChannelRouter: exactly-once across a crash", () => {
  const KINDS = ["message", "stop", "handover", "junk"] as const;

  function interleavings(length: number): string[][] {
    if (length === 0) return [[]];
    const shorter = interleavings(length - 1);
    const out: string[][] = [];
    for (const prefix of shorter) {
      for (const kind of KINDS) out.push([...prefix, kind]);
    }
    return out;
  }

  function runBoot(
    records: SessionStreamRecord[],
    checkpoint: { resumeFrom?: number; appliedThrough?: number },
    takeMessages: number,
    attachStop: boolean
  ) {
    const r = router();
    r.restore(checkpoint);
    const messages: number[] = [];
    const stops: number[] = [];
    if (attachStop) r.on("stop", (record) => stops.push(record.seqNum));

    for (const record of records) {
      if (checkpoint.resumeFrom !== undefined && record.seqNum <= checkpoint.resumeFrom) continue;
      r.ingest(record);
    }

    for (let i = 0; i < takeMessages; i++) {
      const head = r.peek("messages");
      if (!head) break;
      void r.next("messages", { timeoutMs: 0 });
      messages.push(head.seqNum);
    }

    return { messages, stops, checkpoint: r.checkpoint() };
  }

  it("delivers every message exactly once and applies no stop twice", () => {
    const cases = interleavings(4);
    expect(cases.length).toBe(256);

    for (const kinds of cases) {
      const records = kinds.map((kind, index) => rec(index, kind));
      const messageSeqs = records
        .filter((record) => (record.data as Chunk).kind === "message")
        .map((record) => record.seqNum);

      for (let crashAfter = 0; crashAfter <= kinds.length; crashAfter++) {
        const first = runBoot(records, {}, crashAfter, true);
        const second = runBoot(records, first.checkpoint, kinds.length, true);

        const delivered = [...first.messages, ...second.messages];
        expect(delivered, `messages for [${kinds.join(",")}] crashAfter=${crashAfter}`).toEqual(
          messageSeqs
        );

        const appliedTwice = first.stops.filter((seq) => second.stops.includes(seq));
        expect(
          appliedTwice,
          `stops applied twice for [${kinds.join(",")}] crashAfter=${crashAfter}`
        ).toEqual([]);
      }
    }
  });
});

describe("SessionChannelRouter: observe", () => {
  it("notifies without consuming, so the record still queues and holds the floor", () => {
    const r = router();
    const seen: number[] = [];
    r.observe("messages", (record) => seen.push(record.seqNum));

    r.ingest(rec(0, "message"));

    expect(seen).toEqual([0]);
    expect(r.hasPending("messages")).toBe(true);
    expect(r.resumeFloor()).toBeUndefined();
  });

  it("does not satisfy a queue route's handler delivery", () => {
    const r = router();
    const observed: number[] = [];
    const handled: number[] = [];
    r.observe("messages", (record) => observed.push(record.seqNum));

    r.ingest(rec(0, "message"));
    expect(handled).toEqual([]);

    r.on("messages", (record) => handled.push(record.seqNum));
    expect(handled).toEqual([0]);
    expect(observed).toEqual([0]);
  });

  it("rejects an at-arrival route, so a stop with only an observer is still discarded", () => {
    const r = router();
    expect(() => r.observe("stop", () => {})).toThrow(/at-arrival/);
  });

  it("does not re-offer records that were already queued when it attached", () => {
    const r = router();
    r.ingest(rec(0, "message"));

    const seen: number[] = [];
    r.observe("messages", (record) => seen.push(record.seqNum));
    expect(seen).toEqual([]);

    r.ingest(rec(1, "message"));
    expect(seen).toEqual([1]);
  });

  it("stops notifying after off()", () => {
    const r = router();
    const seen: number[] = [];
    const sub = r.observe("messages", (record) => seen.push(record.seqNum));

    r.ingest(rec(0, "message"));
    sub.off();
    r.ingest(rec(1, "message"));

    expect(seen).toEqual([0]);
  });
});

describe("SessionChannelRouter: take", () => {
  it("removes one queued record by sequence and releases the floor", () => {
    const r = router();
    r.ingest(rec(0, "message"));
    r.ingest(rec(1, "message"));

    expect(r.take("messages", 0)).toBe(true);
    expect(r.pendingCount("messages")).toBe(1);
    expect(r.peek("messages")?.seqNum).toBe(1);
  });

  it("reports false for a record that is no longer queued", () => {
    const r = router();
    r.ingest(rec(0, "message"));

    expect(r.take("messages", 0)).toBe(true);
    expect(r.take("messages", 0)).toBe(false);
    expect(r.take("messages", 99)).toBe(false);
  });

  it("leaves an untaken observed record to be delivered as normal", async () => {
    const r = router();
    r.observe("messages", () => {});
    r.ingest(rec(0, "message"));
    r.ingest(rec(1, "message"));

    r.take("messages", 0);

    const next = await r.next("messages", { timeoutMs: 0 });
    expect(next?.seqNum).toBe(1);
  });
});

describe("SessionChannelRouter: clearRoute guard", () => {
  it("refuses to clear a replayable route", () => {
    const r = router();
    r.ingest(rec(0, "message"));

    expect(() => r.clearRoute("messages")).toThrow(/replayable/);
    expect(r.hasPending("messages")).toBe(true);
  });

  it("still clears a non-replayable route", () => {
    const r = router();
    r.ingest(rec(0, "handover"));
    expect(r.hasPending("handover")).toBe(true);

    r.clearRoute("handover");
    expect(r.hasPending("handover")).toBe(false);
  });
});

describe("SessionChannelRouter: observe versus a waiting consumer", () => {
  it("notifies the observer even when a parked puller takes the record", async () => {
    const r = router();
    const seen: number[] = [];
    r.observe("messages", (record) => seen.push(record.seqNum));

    const pull = r.next("messages");
    r.ingest(rec(0, "message"));
    const taken = await pull;

    expect(seen).toEqual([0]);
    expect(taken?.seqNum).toBe(0);
    expect(r.hasPending("messages")).toBe(false);
  });

  it("reports a failed take for a record a puller already consumed", async () => {
    const r = router();
    const seen: number[] = [];
    r.observe("messages", (record) => seen.push(record.seqNum));

    const pull = r.next("messages");
    r.ingest(rec(0, "message"));
    await pull;

    expect(seen).toEqual([0]);
    expect(r.take("messages", 0)).toBe(false);
  });
});

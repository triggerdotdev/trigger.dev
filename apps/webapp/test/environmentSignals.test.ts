// The environment signal stream's latest map, against an in-memory stand-in for S2's conditional
// append: send, the cap, clear, the record size guard, and a lost race.

import { describe, expect, it, vi } from "vitest";

const s2 = vi.hoisted(() => ({
  records: [] as Array<{ seq: number; body: string }>,
  nextSeq: 0,
  /** Appends made by "another process" just before the next conditional append. */
  interleave: [] as string[],
  /** Conditional appends left to lose, as if another send always got there first. */
  lose: 0,
  appends: 0,
  deleted: [] as string[],
  /** Stream deletes left to fail. */
  failDeletes: 0,
}));

vi.mock("~/services/realtime/s2realtimeStreams.server", () => ({
  S2RealtimeStreams: class {
    toEnvironmentStreamName(name: string) {
      return `env/${name}`;
    }
    async readLastRecord() {
      const record = s2.records.at(-1);
      return { nextSeq: s2.nextSeq, ...(record ? { record: { ...record, headers: [] } } : {}) };
    }
    async keepStreamUntilTrimmed() {}
    async deleteStream(stream: string) {
      if (s2.failDeletes > 0) {
        s2.failDeletes--;
        throw new Error("S2 delete stream failed: 500");
      }
      s2.deleted.push(stream);
    }
    async appendIfNextSeq(
      _stream: string,
      records: Array<{ body: string | Uint8Array; headers?: Array<[string, string]> }>,
      matchSeqNum: number
    ) {
      s2.appends++;
      if (s2.lose > 0) {
        s2.lose--;
        return { ok: false as const, nextSeq: s2.nextSeq };
      }
      for (const body of s2.interleave.splice(0)) s2.records.push({ seq: s2.nextSeq++, body });
      if (matchSeqNum !== s2.nextSeq) return { ok: false as const, nextSeq: s2.nextSeq };
      const startSeq = s2.nextSeq;
      for (const record of records) {
        const isTrim = record.headers?.some(([, value]) => value === "trim");
        if (!isTrim) s2.records.push({ seq: s2.nextSeq, body: String(record.body) });
        s2.nextSeq++;
      }
      return { ok: true as const, startSeq };
    }
  },
}));

vi.mock("~/services/realtime/v1StreamsGlobal.server", async () => {
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
  return {
    getRealtimeStreamInstance: () => new (S2RealtimeStreams as unknown as new () => object)(),
  };
});

import { MAX_SIGNAL_KEYS, parseSignalRecord } from "@trigger.dev/core/v3";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  clearEnvironmentSignal,
  deleteEnvironmentSignalStreams,
  isS2Unavailable,
  latestEnvironmentSignal,
  readLatestSignals,
  sendEnvironmentSignal,
  SignalError,
  signalResumeSeq,
  signalStreamsFor,
} from "~/services/realtime/environmentSignals.server";

const environment = { id: "env_1", organization: {} } as unknown as AuthenticatedEnvironment;

function reset() {
  s2.records.length = 0;
  s2.nextSeq = 0;
  s2.interleave.length = 0;
  s2.lose = 0;
  s2.appends = 0;
}

const names = async () =>
  (await readLatestSignals(environment)).map((e) => (e.task ? `${e.name}/${e.task}` : e.name));

describe("environment signals", () => {
  it("keeps the latest of each name and task in the last record", async () => {
    reset();
    await sendEnvironmentSignal(environment, { name: "a", payload: 1 });
    await sendEnvironmentSignal(environment, { name: "a", payload: 2, task: "t" });
    await sendEnvironmentSignal(environment, { name: "a", payload: 3 });
    const latest = await readLatestSignals(environment);
    expect(latest.map((e) => [e.name, e.task, e.payload])).toEqual([
      ["a", undefined, 3],
      ["a", "t", 2],
    ]);
  });

  // Catches: latest() handing a run the untasked value while a newer one for its own task exists
  // (on() delivers the newer first), or a backend asking for one pair getting another's.
  it("latest returns exactly (name, task), or with includeUntasked the newer of the two", async () => {
    reset();
    await sendEnvironmentSignal(environment, { name: "a", payload: "all" });
    await sendEnvironmentSignal(environment, { name: "a", payload: "t", task: "t" });
    const pick = async (input: { name: string; task?: string; includeUntasked?: boolean }) =>
      (await latestEnvironmentSignal(environment, input))?.payload ?? null;

    expect(await pick({ name: "a" })).toBe("all");
    expect(await pick({ name: "a", task: "t" })).toBe("t");
    expect(await pick({ name: "a", task: "other" })).toBeNull();
    expect(await pick({ name: "a", task: "t", includeUntasked: true })).toBe("t");
    expect(await pick({ name: "a", task: "other", includeUntasked: true })).toBe("all");
    expect(await pick({ name: "unknown" })).toBeNull();

    await sendEnvironmentSignal(environment, { name: "a", payload: "all again" });
    expect(await pick({ name: "a", task: "t", includeUntasked: true })).toBe("all again");
    // Reserved names are readable (runs read the platform's own), bad names are not.
    expect(await pick({ name: "trigger.skew-protection-threshold" })).toBeNull();
    await expect(latestEnvironmentSignal(environment, { name: "" })).rejects.toMatchObject({
      status: 400,
    });
  });

  // Catches: latest() returning an entry a direct append planted with a seq past its record, which
  // runs ignore.
  it("latest ignores an entry claiming a later seq than its record", async () => {
    reset();
    s2.records.push({
      seq: 0,
      body: JSON.stringify({
        data: JSON.stringify({
          name: "a",
          latest: [{ name: "a", payload: "forged", sentAt: new Date().toISOString(), seq: 99 }],
        }),
      }),
    });
    s2.nextSeq = 1;
    expect(await latestEnvironmentSignal(environment, { name: "a" })).toBeNull();
  });

  // Catches: a full map refusing new names forever (loop 12 had no way to free one).
  it("refuses a new name when full, naming the cap, until one is cleared", async () => {
    reset();
    for (let i = 0; i < MAX_SIGNAL_KEYS; i++) {
      await sendEnvironmentSignal(environment, { name: `n${i}`, payload: i });
    }
    // The platform's own names don't count.
    await sendEnvironmentSignal(
      environment,
      { name: "trigger.skew-protection-threshold", payload: {} },
      { platform: true }
    );
    // An existing name can still be sent.
    await sendEnvironmentSignal(environment, { name: "n0", payload: "again" });

    const refused = sendEnvironmentSignal(environment, { name: "extra", payload: 1 });
    await expect(refused).rejects.toBeInstanceOf(SignalError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
    await expect(refused).rejects.toThrow(`at most ${MAX_SIGNAL_KEYS} names`);

    expect(await clearEnvironmentSignal(environment, { name: "n1" })).toMatchObject({
      cleared: true,
    });
    expect(await names()).not.toContain("n1");
    await sendEnvironmentSignal(environment, { name: "extra", payload: 1 });
    expect(await names()).toContain("extra");
  });

  it("clears only the pair asked for, and appends nothing when there is nothing to clear", async () => {
    reset();
    await sendEnvironmentSignal(environment, { name: "a", payload: 1 });
    await sendEnvironmentSignal(environment, { name: "a", payload: 2, task: "t" });
    expect(await clearEnvironmentSignal(environment, { name: "a", task: "t" })).toMatchObject({
      cleared: true,
    });
    expect(await names()).toEqual(["a"]);
    const before = s2.nextSeq;
    expect(await clearEnvironmentSignal(environment, { name: "a", task: "t" })).toEqual({
      cleared: false,
    });
    expect(s2.nextSeq).toBe(before);
  });

  it("refuses reserved names from API senders, for send and clear", async () => {
    reset();
    await expect(
      sendEnvironmentSignal(environment, { name: "trigger.skew-protection-threshold", payload: 1 })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      clearEnvironmentSignal(environment, { name: "trigger.skew-protection-threshold" })
    ).rejects.toMatchObject({ status: 400 });
  });

  // Catches: a concurrent send's entry lost by a send that merged an older record.
  it("retries a lost race from a fresh read and keeps the other send's entry", async () => {
    reset();
    await sendEnvironmentSignal(environment, { name: "a", payload: 1 });
    const other = JSON.stringify({
      data: JSON.stringify({
        name: "b",
        latest: [
          { name: "a", payload: 1, sentAt: "2026-11-23T00:00:00Z", seq: 0 },
          { name: "b", payload: 9, sentAt: "2026-11-23T00:00:00Z", seq: 1 },
        ],
      }),
      id: "x",
    });
    s2.interleave.push(other);
    await sendEnvironmentSignal(environment, { name: "c", payload: 3 });
    expect((await names()).sort()).toEqual(["a", "b", "c"]);
    expect(parseSignalRecord(JSON.parse(s2.records.at(-1)!.body).data)?.name).toBe("c");
  });

  // Catches: a burst of API sends making each other (and the platform's threshold signal) lose
  // the conditional append every attempt: a plain error (a 500) per loser, and a threshold change
  // whose signal is never sent.
  it("a burst of concurrent sends lets the platform's send through, and losers get a 503", async () => {
    reset();
    const api = Array.from({ length: 24 }, (_, i) =>
      sendEnvironmentSignal(environment, { name: `burst-${i % 5}`, payload: i })
    );
    const platform = sendEnvironmentSignal(
      environment,
      { name: "trigger.skew-protection-threshold", payload: { environment: "20261124.2" } },
      { platform: true }
    );
    const results = await Promise.allSettled([...api, platform]);

    expect(results.at(-1)?.status).toBe("fulfilled");
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(SignalError);
        expect((result.reason as SignalError).status).toBe(503);
      }
    }
    expect(await names()).toContain("trigger.skew-protection-threshold");
  });

  it("gives up after 5 lost races for API sends and 10 for the platform's, with a 503", async () => {
    reset();
    s2.lose = 100;
    const api = await sendEnvironmentSignal(environment, { name: "a", payload: 1 }).catch(
      (error: unknown) => error
    );
    expect(api).toBeInstanceOf(SignalError);
    expect((api as SignalError).status).toBe(503);
    expect(s2.appends).toBe(5);

    s2.appends = 0;
    const platform = await sendEnvironmentSignal(
      environment,
      { name: "trigger.skew-protection-threshold", payload: {} },
      { platform: true }
    ).catch((error: unknown) => error);
    expect((platform as SignalError).status).toBe(503);
    expect(s2.appends).toBe(10);
  });

  // Catches: a negative resume id replaying every retained record, and one past the tail (a run
  // resuming after its stream was recreated) waiting for a seq that may never come.
  it("resumes after a seq the stream has, otherwise starts at the latest record", async () => {
    reset();
    await sendEnvironmentSignal(environment, { name: "a", payload: 1 });
    await sendEnvironmentSignal(environment, { name: "b", payload: 2 });
    const streams = signalStreamsFor(environment);
    expect(s2.nextSeq).toBe(3);
    expect(await signalResumeSeq(streams, "2")).toBe(2);
    expect(await signalResumeSeq(streams, "0")).toBe(0);
    expect(await signalResumeSeq(streams, "-5")).toBeUndefined();
    expect(await signalResumeSeq(streams, "3")).toBeUndefined();
    expect(await signalResumeSeq(streams, "999999")).toBeUndefined();
    expect(await signalResumeSeq(streams, undefined)).toBeUndefined();
    expect(await signalResumeSeq(streams, "x")).toBeUndefined();
  });
});

// Catches: an S2 outage answered as a 500 error per send (and per SDK retry) instead of a 503,
// or a real bug hidden as one.
describe("isS2Unavailable", () => {
  it("is true for timeouts, failed connections and S2 5xx only", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isS2Unavailable(timeout)).toBe(true);
    expect(isS2Unavailable(new TypeError("fetch failed"))).toBe(true);
    expect(isS2Unavailable(new Error("S2 read last record failed: 503 Service Unavailable"))).toBe(
      true
    );
    expect(isS2Unavailable(new Error("S2 append failed: 400 bad"))).toBe(false);
    expect(isS2Unavailable(new Error("Signal send lost the race 5 times"))).toBe(false);
    expect(isS2Unavailable(new TypeError("x is not a function"))).toBe(false);
  });
});

// Catches: one failed S2 delete failing a project deletion or skipping the other environments.
describe("deleteEnvironmentSignalStreams", () => {
  it("deletes each environment's signals stream and logs a failure without throwing", async () => {
    s2.deleted.length = 0;
    s2.failDeletes = 1;
    const env = (id: string) => ({
      id,
      slug: id,
      organization: { id: "org_1", streamBasinName: null },
    });
    await expect(
      deleteEnvironmentSignalStreams([env("env_a"), env("env_b")])
    ).resolves.toBeUndefined();
    expect(s2.deleted).toEqual(["env/signals"]);
  });
});

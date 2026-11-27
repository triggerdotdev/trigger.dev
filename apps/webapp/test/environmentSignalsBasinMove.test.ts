// Moving an environment's signal stream when its organization's basin changes, against s2-lite with
// two basins: the state carries over, a newer send in the new basin wins, the old stream goes, and
// a second run does nothing.

import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import { MAX_SIGNAL_KEYS, parseSignalRecord } from "@trigger.dev/core/v3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const SHARED = "trigger-local";
const ORG_BASIN = "org-basin-move";

const mocks = vi.hoisted(() => ({ endpoint: "" }));

// The real S2 client, with the basin and stream prefix resolved as the webapp does: the org's basin
// if set, else the shared one (namespaced by org).
vi.mock("~/services/realtime/v1StreamsGlobal.server", async () => {
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
  return {
    getRealtimeStreamInstance: (
      environment: { id: string; slug: string; organization: { id: string } },
      _version: string,
      ctx: { organization: { streamBasinName: string | null } }
    ) => {
      const basin = ctx.organization.streamBasinName ?? SHARED;
      const prefix =
        basin === SHARED
          ? `org/${environment.organization.id}/env/${environment.slug}/${environment.id}`
          : `env/${environment.slug}/${environment.id}`;
      return new S2RealtimeStreams({
        endpoint: `${mocks.endpoint}/v1`,
        basin,
        accessToken: "unused",
        skipAccessTokens: true,
        streamPrefix: prefix,
        logLevel: "error",
      });
    },
  };
});

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  clearEnvironmentSignal,
  latestEnvironmentSignal,
  moveEnvironmentSignalStreams,
  readLatestSignals,
  sendEnvironmentSignal,
  SIGNALS_STREAM,
  signalResumeSeq,
  signalStreamsFor,
} from "~/services/realtime/environmentSignals.server";

let s2: StartedS2Container;

beforeAll(async () => {
  s2 = await createS2Container(undefined, { basin: SHARED });
  mocks.endpoint = s2.endpoint;
  const res = await fetch(`${s2.endpoint}/v1/basins`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer unused" },
    body: JSON.stringify({
      basin: ORG_BASIN,
      config: { create_stream_on_append: true, create_stream_on_read: true },
    }),
  });
  expect(res.ok).toBe(true);
}, 120_000);

afterAll(async () => {
  await s2?.container.stop();
});

let n = 0;
function environmentIn(basin: string | null) {
  n++;
  return {
    id: `env_move_${n}`,
    slug: "prod",
    organization: { id: `org_move_${n}`, streamBasinName: basin },
  } as unknown as AuthenticatedEnvironment;
}

function inBasin(environment: AuthenticatedEnvironment, basin: string | null) {
  return {
    ...environment,
    organization: { ...environment.organization, streamBasinName: basin },
  } as AuthenticatedEnvironment;
}

async function lastRecordOf(environment: AuthenticatedEnvironment) {
  const streams = signalStreamsFor(environment);
  return streams.readLastRecord(streams.toEnvironmentStreamName(SIGNALS_STREAM));
}

/** S2 deletes a stream asynchronously: a read answers 409 while it is being deleted, then empty. */
async function expectStreamGone(environment: AuthenticatedEnvironment) {
  const result = await lastRecordOf(environment).catch((error: Error) => error);
  if (result instanceof Error) expect(result.message).toMatch(/409/);
  else expect(result.nextSeq).toBe(0);
}

describe("moveEnvironmentSignalStreams", () => {
  // Catches: a provisioned org's environments starting with no signals, and the old stream left behind
  it("carries the latest signals into the new basin, deletes the old stream, and re-runs as a no-op", async () => {
    const before = environmentIn(null);
    await sendEnvironmentSignal(before, { name: "skew", payload: { v: 1 } });
    await sendEnvironmentSignal(before, { name: "skew", payload: { v: 2 } });
    await sendEnvironmentSignal(before, { name: "mode", payload: "fast", task: "chat" });

    await moveEnvironmentSignalStreams([before], null, ORG_BASIN);

    const after = inBasin(before, ORG_BASIN);
    const latest = await readLatestSignals(after);
    // In their order, from the old stream's next seq (5) up.
    expect(latest.map((e) => [e.name, e.task, e.payload, e.seq]).sort()).toEqual([
      ["mode", "chat", "fast", 6],
      ["skew", undefined, { v: 2 }, 5],
    ]);
    await expectStreamGone(before);

    // A send after the move merges with the carried state.
    await sendEnvironmentSignal(after, { name: "skew", payload: { v: 3 } });
    await moveEnvironmentSignalStreams([before], null, ORG_BASIN);
    const again = await readLatestSignals(after);
    expect(again.find((e) => e.name === "skew")?.payload).toEqual({ v: 3 });
    expect(again.find((e) => e.name === "mode")?.payload).toBe("fast");
  });

  // Catches: the copy overwriting a send that already reached the new basin
  it("keeps a send that reached the new basin first", async () => {
    const before = environmentIn(ORG_BASIN);
    await sendEnvironmentSignal(before, { name: "skew", payload: "old" });
    const after = inBasin(before, null);
    await sendEnvironmentSignal(after, { name: "skew", payload: "new" });

    await moveEnvironmentSignalStreams([before], ORG_BASIN, null);

    const last = await lastRecordOf(after);
    expect(last.nextSeq).toBe(1);
    const record = parseSignalRecord(JSON.parse(last.record!.body).data);
    expect(record?.latest.map((e) => e.payload)).toEqual(["new"]);
    await expectStreamGone(before);
  });

  // Catches: a send that reached the new basin first making the move drop every other signal,
  // and the copy losing which of an environment-wide and a task signal is newer
  it("merges the other signals under a send that reached the new basin first, in order", async () => {
    const before = environmentIn(null);
    await sendEnvironmentSignal(before, { name: "mode", payload: "slow" });
    await sendEnvironmentSignal(before, { name: "mode", payload: "fast", task: "crawler" });
    await sendEnvironmentSignal(before, { name: "skew", payload: "old" });
    const after = inBasin(before, ORG_BASIN);
    await sendEnvironmentSignal(after, { name: "skew", payload: "new" });

    await moveEnvironmentSignalStreams([before], null, ORG_BASIN);

    const latest = await readLatestSignals(after);
    expect(latest.map((e) => [e.name, e.task, e.payload])).toEqual([
      ["mode", undefined, "slow"],
      ["mode", "crawler", "fast"],
      ["skew", undefined, "new"],
    ]);
    const forCrawler = await latestEnvironmentSignal(after, {
      name: "mode",
      task: "crawler",
      includeUntasked: true,
    });
    expect(forCrawler?.payload).toBe("fast");
    // A run that last saw the old stream's tail (seq 4) resumes before the merged record, and every
    // entry sits above what it was delivered there, so none is skipped as already seen.
    expect(await signalResumeSeq(signalStreamsFor(after), "4")).toBe(4);
    expect(Math.min(...latest.map((e) => e.seq))).toBeGreaterThanOrEqual(5);
    await expectStreamGone(before);
  });

  // Catches: a merged map over the send limits, which would block every later new name or send
  it("drops the oldest carried names that would take the map over the cap, and sends still work", async () => {
    const before = environmentIn(null);
    for (let i = 0; i < MAX_SIGNAL_KEYS; i++) {
      await sendEnvironmentSignal(before, { name: `old-${i}`, payload: i });
    }
    const after = inBasin(before, ORG_BASIN);
    await sendEnvironmentSignal(after, { name: "new", payload: "first" });

    await moveEnvironmentSignalStreams([before], null, ORG_BASIN);

    const names = (await readLatestSignals(after)).map((e) => e.name);
    expect(names).toHaveLength(MAX_SIGNAL_KEYS);
    expect(names).not.toContain("old-0");
    expect(names).toContain("new");
    await expect(
      sendEnvironmentSignal(after, { name: "new", payload: "again" })
    ).resolves.toBeDefined();
    await expect(clearEnvironmentSignal(after, { name: "old-1" })).resolves.toMatchObject({
      cleared: true,
    });
    await expect(
      sendEnvironmentSignal(after, { name: "newer", payload: 1 })
    ).resolves.toBeDefined();
  });

  it("copies nothing from an environment that never sent", async () => {
    const before = environmentIn(null);
    await moveEnvironmentSignalStreams([before], null, ORG_BASIN);
    expect((await lastRecordOf(inBasin(before, ORG_BASIN))).nextSeq).toBe(0);
  });
});

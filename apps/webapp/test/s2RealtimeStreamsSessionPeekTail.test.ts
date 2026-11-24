// The `.out` tail peek against a real S2 (s2-lite in a container): what the agent appends after a
// turn-complete (S2 `trim` command records) and how far the peek reads back past them.

import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { areSessionStreamsIdle } from "~/services/realtime/sessionVersionFloor.server";

describe("S2RealtimeStreams session .out tail peek", () => {
  let s2: StartedS2Container;
  let counter = 0;

  beforeAll(async () => {
    s2 = await createS2Container();
  }, 120_000);

  afterAll(async () => {
    await s2?.container.stop();
  });

  function createStreams() {
    return new S2RealtimeStreams({
      endpoint: `${s2.endpoint}/v1`,
      basin: s2.basin,
      accessToken: "unused",
      skipAccessTokens: true,
      logLevel: "error",
    });
  }

  /** Appends to a fresh session's `.out`, one batch per entry, and returns the session's key. */
  async function seedOut(streams: S2RealtimeStreams, batches: AppendRecord[][]) {
    const key = `peek-${process.pid}-${counter++}`;
    const stream = new S2({
      accessToken: "unused",
      endpoints: { account: s2.endpoint, basin: s2.endpoint },
    })
      .basin(s2.basin)
      .stream(streams.toSessionStreamName(key, "out"));
    for (const batch of batches) {
      await stream.append(AppendInput.create(batch));
    }
    return key;
  }

  /** S2 applies a trim shortly after its command record lands: peek until the records are gone. */
  async function peekOnceTrimmed(streams: S2RealtimeStreams, key: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const tail = await streams.peekSessionOutTail(key);
      if (tail.kind !== "record" || Date.now() > deadline) return tail;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const turnComplete = (inEventId = 0, body = "") =>
    AppendRecord.string({
      body,
      headers: [
        ["trigger-control", "turn-complete"],
        ["session-in-event-id", String(inEventId)],
      ],
    });
  const chunk = () => AppendRecord.string({ body: JSON.stringify({ type: "text-delta" }) });

  it("reads the turn-complete when one trim follows it", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [[chunk(), turnComplete()], [AppendRecord.trim(1)]]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 0,
    });
  });

  // Catches: a peek that reads only the last two records and gives up when both are trim
  // commands, so a session whose agent trimmed twice after its turn-complete reads as unreadable
  // (the run-end check then fails every retry) until another real record lands.
  it("reads the turn-complete when two trims follow it", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [
      [chunk(), turnComplete()],
      [AppendRecord.trim(1)],
      [AppendRecord.trim(1)],
    ]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 0,
    });
  });

  // Catches: the walk past command records giving up too early, so a turn-complete that has up
  // to five trims after it (the six-record bound reaches it) reads as unreadable.
  it("reads the turn-complete when five trims follow it, the last record the walk looks at", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [
      [chunk(), turnComplete()],
      ...Array.from({ length: 5 }, () => [AppendRecord.trim(1)]),
    ]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 0,
    });
  });

  // Catches: the walk past command records having no small bound, so a stream with many trims
  // after its last real record costs a read per trim on every reconnect. Past six records of
  // commands it answers "commands-only" instead.
  it("reports commands-only when six trims follow the turn-complete", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [
      [chunk(), turnComplete()],
      ...Array.from({ length: 6 }, () => [AppendRecord.trim(1)]),
    ]);

    await expect(streams.peekSessionOutTail(key)).resolves.toEqual({ kind: "commands-only" });
  });

  // Catches: a tail read of many records that S2 cuts at its per-read size cap before the newest records,
  // which answered with an older turn-complete (an older `.in` cursor), so the run-end check could
  // start a run that re-answers a message the newest turn already answered.
  it("reads the newest turn-complete when large chunks fill the window past S2's read cap", async () => {
    const streams = createStreams();
    const large = () => AppendRecord.string({ body: "x".repeat(600_000) });
    // The 16 records seeded here start with a large chunk and an older turn-complete, which together
    // fill S2's 1 MiB read cap, so one read of all of them would end at the older turn-complete.
    const key = await seedOut(streams, [
      [large()],
      [turnComplete(0, "x".repeat(500_000))],
      ...Array.from({ length: 11 }, () => [large()]),
      [turnComplete(1)],
      [AppendRecord.trim(1)],
      [AppendRecord.trim(1)],
    ]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 1,
    });
  });

  // Catches: a 2-record tail read that S2 cuts at its per-read size cap after the first record,
  // so the peek answers with an older record (here the chunk, or with other shapes an older
  // turn-complete) and never sees the newest turn-complete beyond the cap.
  it("reads the newest turn-complete when the last two records exceed S2's read cap", async () => {
    const streams = createStreams();
    // S2's largest record (1 MiB metered), so the chunk and the turn-complete after it do not fit
    // in one read.
    const nearlyOneMiB = () => AppendRecord.string({ body: "x".repeat(1_048_568) });
    const key = await seedOut(streams, [[turnComplete(0)], [nearlyOneMiB()], [turnComplete(1)]]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 1,
    });
  });

  // Catches: the short-read check taking a stream that really holds one record for a cut read,
  // and answering with something other than that record.
  it("reads the only record of a one-record stream", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [[turnComplete(3)]]);

    await expect(streams.peekSessionOutTail(key)).resolves.toMatchObject({
      kind: "record",
      control: "turn-complete",
      inEventId: 3,
    });
  });

  // Catches: a trim that deleted the turn-complete itself (its seq is past it) reading as
  // "unknown", which the run-end check retries every time though the stream cannot change until
  // the agent writes again.
  it("reports commands-only when a single trim deleted the turn-complete", async () => {
    const streams = createStreams();
    // seq 0 chunk, seq 1 turn-complete, seq 2 the trim, which deletes everything below seq 2.
    const key = await seedOut(streams, [[chunk(), turnComplete()], [AppendRecord.trim(2)]]);

    await expect(peekOnceTrimmed(streams, key)).resolves.toEqual({ kind: "commands-only" });
  });

  // Catches: a trim far past the tail leaving S2 answering 200 with no records, which reads as
  // "empty" (never written), so the run-end check scans `.in` from the run's start and starts a
  // run that re-answers messages the run already answered.
  it("reports commands-only when a trim past the tail deleted every record", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [[chunk(), turnComplete()], [AppendRecord.trim(99)]]);

    await expect(peekOnceTrimmed(streams, key)).resolves.toEqual({ kind: "commands-only" });
  });

  // Catches: a stream holding only a trim record being read as a stream with a tail record, or
  // as a failed read.
  it("reports commands-only for a stream that holds only a trim", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [[AppendRecord.trim(0)]]);

    await expect(streams.peekSessionOutTail(key)).resolves.toEqual({ kind: "commands-only" });
  });

  // Catches: a `.out` that holds only command records being handled like an empty one, which reads
  // an old run that was never messaged as idle (and its session as safe to move to a new version)
  // when its turn can no longer be read.
  it("does not read a session whose .out holds only command records as idle", async () => {
    const streams = createStreams();
    const key = await seedOut(streams, [[chunk(), turnComplete()], [AppendRecord.trim(2)]]);
    await expect(peekOnceTrimmed(streams, key)).resolves.toEqual({ kind: "commands-only" });

    // `.in` was never written (tail 0), and the run is old and was not started with a message.
    await expect(
      areSessionStreamsIdle(
        streams,
        key,
        { createdAt: new Date(Date.now() - 3_600_000), startedWithMessage: false },
        Date.now()
      )
    ).resolves.toBe(false);
  });

  it("still reads a missing stream as empty", async () => {
    const streams = createStreams();
    await expect(streams.peekSessionOutTail(`peek-missing-${process.pid}`)).resolves.toEqual({
      kind: "empty",
    });
  });
});

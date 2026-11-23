import { describe, expect, it } from "vitest";
import { runMessageWait } from "~/components/sessions/v1/trace/sessionRunTiming";

const root = "2026-11-19T10:00:00.000Z";
const span = (message: string, offsetMs: number, isPartial: boolean) => ({
  data: { message, isPartial, offset: offsetMs * 1_000_000 },
});

describe("runMessageWait", () => {
  // Catches: a chat run idle for hours still counting up as if it were working.
  it("is waiting while the newest wait span is open, since that span's start", () => {
    const wait = runMessageWait({
      rootStartedAt: root,
      events: [
        span("run()", 0, true),
        span("first message", 10, false),
        span("chat turn 1", 20, false),
        span("next message", 5_000, true),
        span("idle", 5_000, true),
      ],
    });
    expect(wait).toEqual({ sinceMs: Date.parse(root) + 5_000 });
  });

  // Catches: an older, earlier-listed wait deciding the state. Events come in tree order, so the
  // turn's wait can be listed before the `run()`-level one even when it started later.
  it("goes by start time, not by position in the list", () => {
    const events = [span("next message", 9_000, false), span("first message", 10, true)];
    expect(runMessageWait({ rootStartedAt: root, events })).toBeUndefined();
  });

  // Catches: a resolved wait (message arrived) still showing "Waiting for message".
  it("isn't waiting once the newest wait closed, or with no wait spans", () => {
    expect(
      runMessageWait({ rootStartedAt: root, events: [span("next message", 10, false)] })
    ).toBeUndefined();
    expect(
      runMessageWait({ rootStartedAt: root, events: [span("chat turn 1", 10, true)] })
    ).toBeUndefined();
    expect(runMessageWait(undefined)).toBeUndefined();
  });

  // Catches: a slow onChatResume() shown as idle with the clocks stopped. The message has arrived
  // and the run is working, though the wait span stays open until the callback returns.
  it("isn't waiting once resume work started inside the open wait", () => {
    const running = [span("next message", 5_000, true), span("onChatResume()", 9_000, true)];
    expect(runMessageWait({ rootStartedAt: root, events: running })).toBeUndefined();
    const finished = [span("next message", 5_000, true), span("onChatResume()", 9_000, false)];
    expect(runMessageWait({ rootStartedAt: root, events: finished })).toBeUndefined();
  });

  // Catches: an earlier wait's resume hiding a later, real wait.
  it("ignores resume work from an earlier wait", () => {
    const events = [
      span("first message", 10, false),
      span("onChatResume()", 20, false),
      span("next message", 5_000, true),
    ];
    expect(runMessageWait({ rootStartedAt: root, events })).toEqual({
      sinceMs: Date.parse(root) + 5_000,
    });
  });

  it("covers the first message waits and leaves the time out without a root start", () => {
    expect(
      runMessageWait({
        rootStartedAt: undefined,
        events: [span("first message (continuation)", 10, true)],
      })
    ).toEqual({ sinceMs: undefined });
  });
});

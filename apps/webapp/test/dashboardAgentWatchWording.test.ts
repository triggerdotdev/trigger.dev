import { describe, expect, it } from "vitest";
import {
  WATCH_KINDS,
  watchIdentity,
  watchResolutions,
  type WatchKind,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import {
  noteFor,
  presentResolvedWatch,
  renderBlockAsText,
  renderResolvedWatchAsText,
  watchConditionLabel,
  watchConfirmationBlockBody,
  watchNoteLine,
  watchTooltipLabel,
} from "~/presenters/v3/dashboardAgent";

/** One spec per kind, so the table below covers every watch the product offers. */
function specFor(kind: WatchKind): WatchSpec {
  const common = { maxHours: 1, note: "", checkEveryMinutes: 5 } as const;
  switch (kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return { ...common, kind, runId: "run_abc123", checkEveryMinutes: 1 };
    case "backlog_drain":
      return { ...common, kind, queue: "email-sends" };
    case "queue_depth_above":
    case "queue_depth_below":
      return { ...common, kind, queue: "email-sends", threshold: 500 };
    case "queue_stalled":
      return { ...common, kind, queue: "email-sends", ticks: 3 };
    case "queue_oldest_age":
      return { ...common, kind, queue: "email-sends", thresholdMinutes: 90 };
    case "error_recurrence":
      return { ...common, kind, fingerprint: "a1b2c3d4e5f6" };
    case "health_recovery":
      return { ...common, kind, report: "health", fromSeverity: "crit" };
  }
}

describe("the watch presenter", () => {
  // Every kind's four registers in one snapshot: the card line, the tooltip, the
  // note and the confirmation headline all come from `watchConditionWording`, so a
  // change to one of them shows up here rather than drifting on one surface.
  it("says each condition the same way on every surface", () => {
    const table = WATCH_KINDS.map((kind) => {
      const spec = { ...specFor(kind), note: noteFor(specFor(kind)) };
      return {
        kind,
        label: watchConditionLabel(spec),
        tooltip: watchTooltipLabel(spec),
        note: spec.note,
        confirmation: watchConfirmationBlockBody({ spec, watchId: "watch_1" }).headline,
      };
    });

    expect(table).toMatchSnapshot();
  });

  // The wake banner, the toast, the email subject and the Slack line all render
  // `presentResolvedWatch`, so every kind x resolution pair has exactly one
  // sentence. A missing cell would throw rather than fall through to silence.
  it("gives every kind and resolution one headline", () => {
    const table = WATCH_KINDS.flatMap((kind) =>
      watchResolutions.map((resolution) => {
        const spec = specFor(kind);
        const presented = presentResolvedWatch({
          kind,
          identity: watchIdentity(spec),
          resolution,
        });
        return {
          kind,
          resolution,
          headline: presented.headline,
          category: presented.category,
          tone: presented.tone,
        };
      })
    );

    expect(table).toMatchSnapshot();
  });

  it("quotes the note in one sentence, and says nothing when there is no note", () => {
    expect(watchNoteLine("tell me when run run_abc123 finishes")).toBe(
      "You asked to be told when: tell me when run run_abc123 finishes"
    );
    expect(watchNoteLine("   ")).toBeNull();
  });

  it("restates the SLA the way the card does, in the note too", () => {
    const spec = specFor("queue_oldest_age");
    expect(noteFor(spec)).toBe("tell me if runs in email-sends wait longer than 1h 30m");
    expect(watchConditionLabel(spec)).toBe("If runs wait longer than 1h 30m");
  });
});

describe("renderBlockAsText", () => {
  it("renders a watch-result block as the lines the card shows", () => {
    const spec = specFor("backlog_drain");
    const block = {
      ...watchConfirmationBlockBody({
        spec: { ...spec, note: noteFor(spec) },
        watchId: "watch_1",
        followUp: { external: { status: "enabled" } },
      }),
      id: "watch_1",
      revision: 0,
      version: 1,
    };

    expect(renderBlockAsText(block)).toBe(
      [
        "Watching email-sends until the queue drains.",
        "Checking every 5 min for up to 1 hour. It reports once, then stops.",
        "You'll get an email as well as the chat.",
      ].join("\n")
    );
  });

  it("renders a confirmation whose email couldn't be attached", () => {
    const spec = specFor("backlog_drain");
    const block = {
      ...watchConfirmationBlockBody({
        spec: { ...spec, note: noteFor(spec) },
        watchId: "watch_1",
        followUp: { external: { status: "unavailable", reason: "email_alerts_not_configured" } },
      }),
      id: "watch_1",
      revision: 0,
      version: 1,
    };

    expect(renderBlockAsText(block)).toBe(
      [
        "Watching email-sends until the queue drains.",
        "Checking every 5 min for up to 1 hour. It reports once, then stops.",
        "I couldn't add email notifications, so updates will appear in the dashboard only.",
      ].join("\n")
    );
  });

  it("renders an actions block as its labels", () => {
    expect(
      renderBlockAsText({
        type: "actions",
        actions: [{ label: "Set up a watch", intent: { kind: "ask", prompt: "watch it" } }],
      })
    ).toBe("- Set up a watch");
  });

  it("renders a resolved watch as headline, note and facts", () => {
    const spec = specFor("run_finished");
    expect(
      renderResolvedWatchAsText({
        resolved: {
          kind: "run_finished",
          identity: watchIdentity(spec),
          resolution: "condition_met",
        },
        note: "tell me when run run_abc123 finishes",
        facts: [{ label: "Status", value: "COMPLETED_SUCCESSFULLY" }],
      })
    ).toBe(
      [
        "Run run_abc123 finished",
        "You asked to be told when: tell me when run run_abc123 finishes",
        "Status: COMPLETED_SUCCESSFULLY",
      ].join("\n")
    );
  });
});

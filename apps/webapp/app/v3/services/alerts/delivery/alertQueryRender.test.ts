import { createElement } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Writable } from "node:stream";
import Email from "emails/emails/alert-raised";
import { alertQueryDetail, boundDetail, linkFingerprint } from "emails/src/alertRaisedContent";
import { describe, expect, it } from "vitest";
import { alertEventChatText } from "./alertEventChatText";
import { buildAlertSlackMessage } from "./alertSlackMessage";

const alert = { name: "Slow queues", capabilityKey: "custom.query" };

const thresholdFacts = {
  measure: "depth",
  value: 142,
  threshold: 100,
  windowSec: 300,
  offenders: [
    { key: "emails", value: 142 },
    { key: "billing", value: 120 },
  ],
};

const matchFacts = {
  batch: {
    rows: Array.from({ length: 10 }, (_, i) => ({
      id: `run_${i}`,
      time: "2026-10-15T11:40:12.000Z",
      columns: { status: "FAILED", task: `t${i}` },
    })),
    total: 15,
    overflow: 5,
  },
};

const thresholdText = [
  "Slow queues: depth 142 above 100 over 5m",
  "emails: 142",
  "billing: 120",
].join("\n");

describe("alertQueryDetail", () => {
  it("renders threshold with measure, value, window and offenders", () => {
    expect(alertQueryDetail(thresholdFacts, "Slow queues")).toBe(thresholdText);
  });

  it("says below when the value is under the threshold", () => {
    expect(
      alertQueryDetail({ measure: "rate", value: 1, threshold: 5, windowSec: 3600 }, "A")
    ).toBe("A: rate 1 below 5 over 1h");
  });

  it("caps offenders at 10", () => {
    const offenders = Array.from({ length: 14 }, (_, i) => ({ key: `g${i}`, value: i }));
    const lines = alertQueryDetail({ ...thresholdFacts, offenders }, "A")!.split("\n");
    expect(lines).toHaveLength(11);
  });

  it("lists 10 rows and an overflow line for 15 matches", () => {
    const lines = alertQueryDetail(matchFacts, "Slow queues")!.split("\n");
    expect(lines[0]).toBe("Slow queues: 15 new rows");
    expect(lines[1]).toBe("run_0 · 2026-10-15 11:40 UTC · status=FAILED, task=t0");
    expect(lines).toHaveLength(12);
    expect(lines[11]).toBe("and 5 more");
  });

  it("caps rows at 10 even if the batch carries more", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`,
      time: "2026-10-15T11:40:12.000Z",
    }));
    const lines = alertQueryDetail({ batch: { rows, total: 15, overflow: 5 } }, "A")!.split("\n");
    expect(lines).toHaveLength(12);
  });

  it("has no overflow line when everything is shown", () => {
    const batch = { rows: matchFacts.batch.rows.slice(0, 2), total: 2, overflow: 0 };
    expect(alertQueryDetail({ batch }, "A")).not.toContain("more");
  });

  it("returns null without measure and value", () => {
    expect(alertQueryDetail({ threshold: 1 }, "A")).toBeNull();
  });
});

describe("custom.query renderers", () => {
  it("chat text carries threshold detail", () => {
    expect(alertEventChatText({ type: "raised", facts: thresholdFacts }, alert)).toBe(
      `Alert raised: Slow queues\n${thresholdText}`
    );
  });

  it("chat text carries 10 rows and the overflow line", () => {
    const text = alertEventChatText({ type: "raised", facts: matchFacts }, alert);
    expect(text).toContain("run_9 ·");
    expect(text).not.toContain("run_10");
    expect(text.endsWith("and 5 more")).toBe(true);
  });

  it("slack message includes the detail section and the dashboard link", () => {
    const link = "https://cloud.trigger.dev/alerts/alert_1";
    const { blocks } = buildAlertSlackMessage({
      alertName: "Slow queues",
      headline: "Slow queues",
      project: "p",
      environment: "Prod",
      raisedAt: "2026-10-15T11:40:12.000Z",
      detail: alertQueryDetail(matchFacts, "Slow queues"),
      dashboardLink: link,
    });
    const texts = blocks.map((b) => (b as any).text?.text ?? "");
    expect(texts.some((t: string) => t.includes("and 5 more"))).toBe(true);
    expect((blocks.at(-1) as any).elements[0].url).toBe(link);
  });

  it("leaves errors.new chat text untouched", () => {
    const text = alertEventChatText(
      {
        type: "raised",
        facts: {
          task_identifier: "lightpanda-cdp",
          error_fingerprint: "a0b0310f7c3f238c",
          measure: "x",
          batch: matchFacts.batch,
        },
      },
      { name: "New errors", capabilityKey: "errors.new" },
      "Error: connection refused"
    );
    expect(text).toBe(
      "Alert raised: New errors. lightpanda-cdp: Error: connection refused — New error group."
    );
  });
});

const longRows = {
  batch: {
    rows: Array.from({ length: 10 }, (_, i) => ({
      id: `run_${i}`,
      time: "2026-10-15T11:40:12.000Z",
      columns: { a: "x".repeat(500), b: { deep: "y".repeat(500) }, c: "<z>".repeat(200) },
    })),
    total: 15,
    overflow: 5,
  },
};

function renderHtml(element: ReturnType<typeof createElement>): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
      final(cb) {
        resolve(out);
        cb();
      },
    });
    const stream = renderToPipeableStream(element, {
      onAllReady: () => stream.pipe(sink),
      onError: reject,
    });
  });
}

describe("bounded query renderings", () => {
  it("truncates long cells", () => {
    const line = alertQueryDetail(longRows, "A")!.split("\n")[1]!;
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(400);
  });

  it("keeps the slack detail section under 3000 chars", () => {
    const { blocks } = buildAlertSlackMessage({
      alertName: "A",
      headline: "A",
      project: "p",
      environment: "e",
      raisedAt: "2026-10-15T11:40:12.000Z",
      detail: alertQueryDetail(longRows, "A"),
      dashboardLink: "https://x.test",
    });
    for (const b of blocks) {
      expect(((b as any).text?.text ?? "").length).toBeLessThanOrEqual(3000);
    }
  });

  it("says at when value equals threshold", () => {
    expect(alertQueryDetail({ measure: "m", value: 5, threshold: 5 }, "A")).toBe("A: m 5 at 5");
  });

  it("never uses an error link for custom.query", () => {
    const facts = { error_fingerprint: "abc" };
    expect(linkFingerprint("custom.query", facts)).toBeNull();
    expect(linkFingerprint("errors.new", facts)).toBe("abc");
  });

  it("renders rows and overflow as separate lines in the email", async () => {
    const html = await renderHtml(
      createElement(Email, {
        email: "alert-raised",
        alertName: "A",
        capabilityKey: "custom.query",
        headline: "A",
        raisedAt: "2026-10-15T11:40:12.000Z",
        detail: alertQueryDetail(longRows, "A"),
        facts: [],
        dashboardLink: "https://x.test",
        organization: "o",
        project: "p",
        environment: "e",
      })
    );
    expect(html).toMatch(/<p[^>]*>run_0 ·/);
    expect(html).toMatch(/<p[^>]*>and 5 more<\/p>/);
  });

  it("caps long row ids", () => {
    const batch = { rows: [{ id: "i".repeat(5000), time: "2026-10-15T11:40:12.000Z" }], total: 1 };
    expect(alertQueryDetail({ batch }, "A")!.length).toBeLessThan(200);
  });

  it("never cuts inside an escape entity", () => {
    const text = `${"x".repeat(2897)}${"&amp;".repeat(100)}`;
    const out = boundDetail(text, 2900);
    expect(out).not.toMatch(/&[a-z#0-9]*\n…$/i);
    expect(out.endsWith("\n…")).toBe(true);
  });
});

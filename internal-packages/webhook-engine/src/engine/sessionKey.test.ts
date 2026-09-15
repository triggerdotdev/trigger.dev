import { describe, expect, it } from "vitest";
import { evaluateSessionKeyTemplate } from "./sessionKey.js";

const meta = {
  externalRef: "inst_42",
  tenantId: "tnt_1",
  id: "github-issues",
  source: "github",
  deliveryId: "dlv_abc",
};

const ns = (body: unknown, header: Record<string, string> = {}) => ({
  body,
  webhook: meta,
  header,
});

describe("evaluateSessionKeyTemplate", () => {
  it("resolves a nested body path", () => {
    expect(evaluateSessionKeyTemplate("{body.issue.id}", ns({ issue: { id: 99 } }))).toBe("99");
  });

  it("treats a bare path as the body namespace", () => {
    expect(evaluateSessionKeyTemplate("{issue.id}", ns({ issue: { id: 7 } }))).toBe("7");
  });

  it("resolves webhook meta and composes literals", () => {
    expect(
      evaluateSessionKeyTemplate("{webhook.externalRef}-{body.issue.id}", ns({ issue: { id: 5 } }))
    ).toBe("inst_42-5");
  });

  it("matches headers case-insensitively", () => {
    expect(
      evaluateSessionKeyTemplate("{header.x-installation}", ns({}, { "X-Installation": "abc" }))
    ).toBe("abc");
  });

  it("resolves a composite across all three namespaces", () => {
    expect(
      evaluateSessionKeyTemplate(
        "{webhook.tenantId}/{header.x-inst}/{body.issue.id}",
        ns({ issue: { id: 3 } }, { "x-inst": "i9" })
      )
    ).toBe("tnt_1/i9/3");
  });

  it("returns undefined when a body path is missing", () => {
    expect(
      evaluateSessionKeyTemplate("{body.issue.nope}", ns({ issue: { id: 1 } }))
    ).toBeUndefined();
  });

  it("returns undefined for an unknown webhook meta field", () => {
    expect(evaluateSessionKeyTemplate("{webhook.installationId}", ns({}))).toBeUndefined();
  });

  it("returns undefined for a missing header", () => {
    expect(
      evaluateSessionKeyTemplate("{header.x-nope}", ns({}, { "x-inst": "i9" }))
    ).toBeUndefined();
  });

  it("returns undefined when a value is empty string", () => {
    expect(evaluateSessionKeyTemplate("{body.region}", ns({ region: "" }))).toBeUndefined();
  });

  it("coerces numbers and booleans (including 0/false) to strings", () => {
    expect(evaluateSessionKeyTemplate("{body.n}-{body.b}", ns({ n: 0, b: false }))).toBe("0-false");
  });

  it("falls back to the next path with || when the first is empty (Slack thread_ts || ts)", () => {
    const template = "{body.channel}:{body.thread_ts || body.ts}";
    // reply: thread_ts present -> used
    expect(
      evaluateSessionKeyTemplate(template, ns({ channel: "C1", thread_ts: "t1", ts: "m2" }))
    ).toBe("C1:t1");
    // thread start: no thread_ts -> falls back to ts
    expect(evaluateSessionKeyTemplate(template, ns({ channel: "C1", ts: "m2" }))).toBe("C1:m2");
  });

  it("uses the first non-empty across a || chain, else undefined", () => {
    expect(evaluateSessionKeyTemplate("{body.a || body.b || body.c}", ns({ c: "z" }))).toBe("z");
    expect(evaluateSessionKeyTemplate("{body.a || body.b}", ns({}))).toBeUndefined();
  });
});

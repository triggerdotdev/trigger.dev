import { describe, expect, it } from "vitest";
import { evaluateFilter, FilterParseError, parseFilter } from "./index.js";
import type { FilterContext } from "./index.js";

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  event: {
    action: "created",
    issue: { number: 200, author: "alice" },
    repository: { full_name: "myorg/repo", private: false },
  },
  headers: { "X-GitHub-Event": "issue_comment", "Content-Type": "application/json" },
  webhook: { externalRef: "install_42", tenantId: "t1", source: "github" },
  ...over,
});

const matches = (filter: string, over?: Partial<FilterContext>) =>
  evaluateFilter(parseFilter(filter), ctx(over)).match;

describe("parseFilter", () => {
  it("parses a single clause", () => {
    expect(parseFilter("event.action == 'created'")).toEqual({
      kind: "clause",
      path: "event.action",
      op: "eq",
      value: "created",
    });
  });

  it("respects && binding tighter than || (DNF)", () => {
    expect(
      parseFilter(
        "event.action == 'created' || event.action == 'edited' && event.repository.private == false"
      )
    ).toEqual({
      kind: "or",
      clauses: [
        { kind: "clause", path: "event.action", op: "eq", value: "created" },
        {
          kind: "and",
          clauses: [
            { kind: "clause", path: "event.action", op: "eq", value: "edited" },
            { kind: "clause", path: "event.repository.private", op: "eq", value: false },
          ],
        },
      ],
    });
  });

  it("parses parens, lists, numbers, not in", () => {
    expect(parseFilter("event.action in ['created', 'edited']").value).toEqual([
      "created",
      "edited",
    ]);
    expect(parseFilter("event.issue.number > 100")).toMatchObject({ op: "gt", value: 100 });
    expect(parseFilter("event.action not in ['deleted']")).toMatchObject({ op: "nin" });
    expect(parseFilter("( event.action == 'created' )")).toMatchObject({ kind: "clause" });
  });

  it("rejects malformed filters", () => {
    for (const bad of [
      "event.action",
      "event.action = 'x'",
      "foo.bar == 'x'",
      "event.action == 'created' && ( event.action == 'edited'",
      "",
    ]) {
      expect(() => parseFilter(bad), bad).toThrow(FilterParseError);
    }
  });

  it("enforces the soft clause cap", () => {
    const big = Array.from({ length: 60 }, () => "event.action == 'created'").join(" && ");
    expect(() => parseFilter(big)).toThrow(/too complex/);
  });
});

describe("evaluateFilter", () => {
  it("matches equality, and, or, in, numeric, parens", () => {
    expect(matches("event.action == 'created'")).toBe(true);
    expect(matches("event.action == 'created' && event.repository.private == false")).toBe(true);
    expect(matches("event.action == 'edited' || event.action == 'created'")).toBe(true);
    expect(matches("event.action in ['edited', 'created']")).toBe(true);
    expect(matches("event.issue.number > 100")).toBe(true);
    expect(matches("event.issue.number > 500")).toBe(false);
    expect(
      matches(
        "( event.action == 'edited' || event.action == 'created' ) && event.repository.private == false"
      )
    ).toBe(true);
  });

  it("looks up headers case-insensitively", () => {
    expect(matches("header.x-github-event == 'issue_comment'")).toBe(true);
  });

  it("resolves the webhook namespace", () => {
    expect(matches("webhook.externalRef == 'install_42'")).toBe(true);
    expect(matches("webhook.externalRef == 'other'")).toBe(false);
  });

  it("treats a missing field correctly", () => {
    expect(matches("event.assignee == 'bob'")).toBe(false);
    expect(matches("event.assignee != 'bob'")).toBe(true);
    expect(matches("event.assignee == null")).toBe(true);
  });

  it("string operators", () => {
    expect(matches("event.repository.full_name startsWith 'myorg/'")).toBe(true);
    expect(matches("event.repository.full_name contains 'repo'")).toBe(true);
    expect(matches("event.repository.full_name endsWith '/other'")).toBe(false);
  });

  it("field-to-field: parses a path RHS as a valueRef and compares two event fields", () => {
    expect(parseFilter("event.issue.author == event.repository.full_name")).toEqual({
      kind: "clause",
      path: "event.issue.author",
      op: "eq",
      valueRef: "event.repository.full_name",
    });
    expect(matches("event.issue.author == event.issue.author")).toBe(true);
    expect(matches("event.issue.author == event.repository.full_name")).toBe(false);
    expect(matches("event.issue.number >= event.issue.number")).toBe(true);
  });

  it("returns a reason naming the failing clause", () => {
    const r = evaluateFilter(
      parseFilter("event.action == 'created' && event.issue.number > 500"),
      ctx()
    );
    expect(r.match).toBe(false);
    expect(r.reason).toContain("event.issue.number");
    expect(r.reason).toContain("> 500");
  });
});

describe("quantifiers", () => {
  const arrCtx = (): FilterContext => ({
    event: {
      action: "push",
      commits: [{ message: "fix bug" }, { message: "deploy to prod" }],
      labels: [{ name: "bug" }, { name: "urgent" }],
    },
    headers: {},
    webhook: {},
  });
  const m = (filter: string) => evaluateFilter(parseFilter(filter), arrCtx()).match;

  it("parses a quantifier sub-clause", () => {
    expect(parseFilter("event.commits any ( message startsWith 'deploy' )")).toEqual({
      kind: "quantifier",
      mode: "any",
      path: "event.commits",
      clause: { path: "message", op: "startsWith", value: "deploy" },
    });
  });

  it("evaluates any / all over array elements", () => {
    expect(m("event.commits any ( message startsWith 'deploy' )")).toBe(true);
    expect(m("event.commits any ( message startsWith 'nope' )")).toBe(false);
    expect(m("event.labels all ( name != 'wontfix' )")).toBe(true);
    expect(m("event.labels all ( name == 'bug' )")).toBe(false);
  });

  it("composes with top-level boolean operators", () => {
    expect(m("event.action == 'push' && event.labels any ( name == 'urgent' )")).toBe(true);
  });

  it("a non-array path does not match", () => {
    expect(evaluateFilter(parseFilter("event.action any ( x == 'y' )"), arrCtx()).match).toBe(
      false
    );
  });
});

// The @trigger.dev/slack self-message loop guard: route only genuine human messages, drop the bot's
// own posts (bot_id present), edits/deletes, and Slack system messages. Proves the loop is closed.
describe("slack self-message guard", () => {
  const GUARD =
    "event.event.type == 'message' && event.event.bot_id == null && event.event.subtype in [null, 'file_share', 'thread_broadcast']";
  const ev = (event: Record<string, unknown>): Partial<FilterContext> => ({ event: { event } });

  it("routes a human message in a thread", () => {
    expect(
      evaluateFilter(parseFilter(GUARD), ctx(ev({ type: "message", channel: "C1", ts: "1" }))).match
    ).toBe(true);
  });

  it("drops a channel_join system message (bot invited to the channel)", () => {
    expect(
      evaluateFilter(
        parseFilter(GUARD),
        ctx(ev({ type: "message", subtype: "channel_join", text: "has joined" }))
      ).match
    ).toBe(false);
  });

  it("drops the bot's own post (bot_id present)", () => {
    expect(
      evaluateFilter(
        parseFilter(GUARD),
        ctx(ev({ type: "message", bot_id: "B123", text: "reply" }))
      ).match
    ).toBe(false);
  });

  it("drops an edit re-delivery (message_changed subtype)", () => {
    expect(
      evaluateFilter(parseFilter(GUARD), ctx(ev({ type: "message", subtype: "message_changed" })))
        .match
    ).toBe(false);
  });

  it("drops an app_mention duplicate (dedupes to the message event)", () => {
    expect(
      evaluateFilter(parseFilter(GUARD), ctx(ev({ type: "app_mention", text: "hey" }))).match
    ).toBe(false);
  });
});

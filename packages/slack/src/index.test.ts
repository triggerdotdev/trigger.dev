import { describe, expect, it, vi } from "vitest";
import { mentions, slack, toSlackMrkdwn, type SlackMessageEvent } from "./index.js";

const messageEvent = (
  over: Partial<NonNullable<SlackMessageEvent["event"]>> = {}
): SlackMessageEvent => ({
  type: "event_callback",
  event: { type: "message", channel: "C9", ts: "1699999999.0001", text: "hi", ...over },
});

describe("slack channel", () => {
  it("default inbound strips a leading bot mention", () => {
    const c = slack({ id: "s1", token: "xoxb-t" });
    expect(c.inbound(messageEvent({ text: "<@U123> hello there" }))).toBe("hello there");
    expect(c.inbound(messageEvent({ text: "plain" }))).toBe("plain");
  });

  it("composes the self-message guard with a user filter, and always admits interactivity", () => {
    const guardOnly = slack({ id: "s2", token: "t" });
    expect(guardOnly.filter).toContain("event.event.type == 'message'");
    expect(guardOnly.filter).toContain("event.event.bot_id == null");
    expect(guardOnly.filter).toContain(
      "event.event.subtype in [null, 'file_share', 'thread_broadcast']"
    );
    expect(guardOnly.filter).toContain("event.type == 'block_actions'");

    const withUser = slack({ id: "s3", token: "t", filter: "event.event.channel == 'C1'" });
    expect(withUser.filter).toContain("&& (event.event.channel == 'C1')");
    expect(withUser.filter).toContain("event.type == 'block_actions'");
  });

  it("keys one session per thread, converging message events and interactivity", () => {
    const c = slack({ id: "s4", token: "t" });
    expect(c.key).toBe(
      "{body.team_id || body.team.id}:{body.event.channel || body.container.channel_id}:{body.event.thread_ts || body.event.ts || body.container.thread_ts || body.container.message_ts}"
    );
  });

  it("renderInteraction produces Block Kit approve/deny buttons carrying the toolCallId", () => {
    const c = slack({ id: "s-hitl", token: "t" });
    const msg = c.renderInteraction?.(
      [{ toolCallId: "call-1", toolName: "requestApproval", input: { amount: 50 } }],
      {
        event: messageEvent(),
        deliveryId: "d1",
      }
    );
    const values = (msg?.blocks as any[]).flatMap((b) => b.elements ?? []).map((e: any) => e.value);
    expect(values).toContain("call-1::approve");
    expect(values).toContain("call-1::deny");
  });

  it("onInteraction resolves a block_actions click to a tool output; ignores messages", () => {
    const c = slack({ id: "s-hitl2", token: "t" });
    const approve = c.onInteraction?.({
      type: "block_actions",
      actions: [{ value: "call-9::approve" }],
    } as never);
    expect(approve).toEqual({ toolCallId: "call-9", output: { approved: true } });

    const deny = c.onInteraction?.({
      type: "block_actions",
      actions: [{ value: "call-9::deny" }],
    } as never);
    expect(deny).toEqual({ toolCallId: "call-9", output: { approved: false } });

    expect(c.onInteraction?.(messageEvent())).toBeNull();
  });

  it("finalizeInteraction replaces the controls via response_url, dropping the buttons", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { json: async () => ({ ok: true }) };
      })
    );
    const c = slack({ id: "s-fin", token: "t" });
    await c.finalizeInteraction?.(
      {
        type: "block_actions",
        user: { id: "U42" },
        response_url: "https://hooks.slack.test/r/1",
        actions: [{ value: "call-1::approve" }],
        message: {
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "Approval needed" } },
            { type: "actions", elements: [{ type: "button", value: "call-1::approve" }] },
          ],
        },
      } as never,
      { toolCallId: "call-1", output: { approved: true } }
    );
    expect(calls[0]?.url).toBe("https://hooks.slack.test/r/1");
    expect(calls[0]?.body.replace_original).toBe(true);
    const types = (calls[0]?.body.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain("actions");
    expect(JSON.stringify(calls[0]?.body.blocks)).toContain("Approved");
    vi.unstubAllGlobals();
  });

  it("finalizeInteraction is a no-op without a response_url", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = slack({ id: "s-fin2", token: "t" });
    await c.finalizeInteraction?.(
      { type: "block_actions", actions: [{ value: "x::deny" }] } as never,
      { toolCallId: "x", output: { approved: false } }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("passes startOn through verbatim (not composed with the guard)", () => {
    const none = slack({ id: "s5", token: "t" });
    expect(none.startOn).toBeUndefined();

    const summon = slack({ id: "s6", token: "t", startOn: mentions("U012BOT") });
    expect(summon.startOn).toBe(
      "(event.event.text contains '<@U012BOT>' || event.event.text contains '<@U012BOT|')"
    );
  });

  it("default ack varies text on crash recovery", () => {
    const c = slack({ id: "s7", token: "t" });
    expect(c.ack?.(messageEvent(), { recovered: false })).toEqual({ text: "on it..." });
    expect(c.ack?.(messageEvent(), { recovered: true })).toEqual({
      text: "picking this back up...",
    });
  });

  it("ack: null disables the placeholder", () => {
    const c = slack({ id: "s8", token: "t", ack: null });
    expect(c.ack).toBeUndefined();
  });

  it("a custom ack receives the recovery ctx", () => {
    const c = slack({
      id: "s9",
      token: "t",
      ack: (_e, ctx) => ({ text: ctx.recovered ? "resuming" : "starting" }),
    });
    expect(c.ack?.(messageEvent(), { recovered: false })).toEqual({ text: "starting" });
    expect(c.ack?.(messageEvent(), { recovered: true })).toEqual({ text: "resuming" });
  });

  it("toSlackMrkdwn converts common markdown to Slack mrkdwn", () => {
    expect(toSlackMrkdwn("**bold**")).toBe("*bold*");
    expect(toSlackMrkdwn("__bold__")).toBe("*bold*");
    expect(toSlackMrkdwn("## Heading")).toBe("*Heading*");
    expect(toSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
    expect(toSlackMrkdwn("[docs](https://trigger.dev)")).toBe("<https://trigger.dev|docs>");
    expect(toSlackMrkdwn("~~gone~~")).toBe("~gone~");
    // A real model reply: heading + bold + bullets in one string.
    expect(toSlackMrkdwn("## Help\n\nI can do **stuff**:\n- a\n- b")).toBe(
      "*Help*\n\nI can do *stuff*:\n• a\n• b"
    );
  });

  it("mentions() builds a mention predicate for one or many bot ids", () => {
    expect(mentions("U1")).toBe(
      "(event.event.text contains '<@U1>' || event.event.text contains '<@U1|')"
    );
    expect(mentions("U1", "U2")).toContain("<@U1>");
    expect(mentions("U1", "U2")).toContain("<@U2|");
    expect(() => mentions()).toThrow(/at least one/);
  });

  it("send posts then edits, threading the ref and using the bot token", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
        return { json: async () => ({ ok: true, ts: "1700000000.0001" }) };
      })
    );

    const c = slack({ id: "s5", token: "xoxb-secret", apiBaseUrl: "https://mock.slack" });
    const event = messageEvent();

    const ackRes = await c.send!(
      { text: "on it..." },
      {
        event,
        deliveryId: "d1",
        mode: "final",
        final: false,
      }
    );
    expect(ackRes.ref).toBe("1700000000.0001");
    expect(calls[0]?.url).toBe("https://mock.slack/chat.postMessage");
    expect(calls[0]?.auth).toBe("Bearer xoxb-secret");
    expect(calls[0]?.body.channel).toBe("C9");
    expect(calls[0]?.body.thread_ts).toBe("1699999999.0001");

    await c.send!(
      { text: "done" },
      {
        event,
        deliveryId: "d1",
        previousRef: ackRes.ref,
        mode: "final",
        final: true,
      }
    );
    expect(calls[1]?.url).toBe("https://mock.slack/chat.update");
    expect(calls[1]?.body.ts).toBe("1700000000.0001");
    expect(calls[1]?.body.text).toBe("done");

    vi.unstubAllGlobals();
  });

  it("send targets the thread from a block_actions payload (HITL resume egress)", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: JSON.parse(init.body) });
        return { json: async () => ({ ok: true, ts: "1700000000.9" }) };
      })
    );
    const c = slack({ id: "s-resume", token: "t", apiBaseUrl: "https://mock.slack" });
    const interaction = {
      type: "block_actions",
      team: { id: "T1" },
      container: {
        type: "message",
        channel_id: "C42",
        thread_ts: "1699999999.0001",
        message_ts: "1700000000.5",
      },
      actions: [{ value: "call-1::approve" }],
    };
    await c.send!(
      { text: "refund approved and processed" },
      {
        event: interaction as never,
        deliveryId: "d-resume",
        mode: "final",
        final: true,
      }
    );
    expect(calls[0]?.body.channel).toBe("C42");
    expect(calls[0]?.body.thread_ts).toBe("1699999999.0001");
    vi.unstubAllGlobals();
  });

  it("send throws when the bot is not in the channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ok: false, error: "not_in_channel" }) }))
    );
    const c = slack({ id: "s6", token: "t", apiBaseUrl: "https://mock.slack" });
    await expect(
      c.send!({ text: "x" }, { event: messageEvent(), deliveryId: "d", mode: "final", final: true })
    ).rejects.toThrow(/not_in_channel/);
    vi.unstubAllGlobals();
  });

  it("react adds/removes an emoji on the triggering message (colons stripped)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { json: async () => ({ ok: true }) };
      })
    );
    const c = slack({
      id: "s7",
      token: "xoxb-secret",
      apiBaseUrl: "https://mock.slack",
      reactions: { working: "eyes", done: "white_check_mark" },
    });
    expect(c.reactions).toEqual({ working: "eyes", done: "white_check_mark" });

    await c.react!({ name: "eyes" }, { event: messageEvent(), deliveryId: "d1" });
    expect(calls[0]?.url).toBe("https://mock.slack/reactions.add");
    expect(calls[0]?.body).toMatchObject({
      channel: "C9",
      timestamp: "1699999999.0001",
      name: "eyes",
    });

    await c.react!(
      { name: ":white_check_mark:", remove: true },
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect(calls[1]?.url).toBe("https://mock.slack/reactions.remove");
    expect(calls[1]?.body.name).toBe("white_check_mark");
    vi.unstubAllGlobals();
  });

  it("react swallows already_reacted (idempotent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ok: false, error: "already_reacted" }) }))
    );
    const c = slack({ id: "s8", token: "t", apiBaseUrl: "https://mock.slack" });
    await expect(
      c.react!({ name: "eyes" }, { event: messageEvent(), deliveryId: "d1" })
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});

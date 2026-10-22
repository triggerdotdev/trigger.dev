import { webhook, webhooks } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  appMentions,
  isSlackResponseUrl,
  readableToolName,
  mentions,
  slack,
  slackButton,
  slackFileParts,
  toSlackBlocks,
  toSlackMrkdwn,
  webhookSource,
  type SlackMessageEvent,
  type SlackSurface,
  type SlackSlashCommand,
} from "./index.js";

const slackEvents = webhooks.endpoint.define({ id: "slack-test", source: webhookSource() });

const toolValue = (t: string, o: unknown) => JSON.stringify({ t, o });

const messageEvent = (
  over: Partial<NonNullable<SlackMessageEvent["event"]>> = {}
): SlackMessageEvent => ({
  type: "event_callback",
  event: { type: "message", channel: "C9", ts: "1699999999.0001", text: "hi", ...over },
});

type SlackCall = { method: string; body: Record<string, unknown>; auth: unknown };

/**
 * Stub fetch with a Slack Web API mock. `reply` answers each call (default `{ ok: true }`); return
 * a `Response` for status codes and headers, or throw to simulate a dropped connection.
 */
function mockSlack(
  reply: (call: SlackCall, index: number) => unknown = () => ({ ok: true })
): SlackCall[] {
  const calls: SlackCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const call = {
        method: url.split("/").pop()!,
        body: JSON.parse(init.body) as Record<string, unknown>,
        auth: init.headers.authorization,
      };
      calls.push(call);
      const answer = await reply(call, calls.length - 1);
      return answer instanceof Response ? answer : Response.json(answer);
    })
  );
  return calls;
}

describe("slack endpoint", () => {
  it("is a Slack source with the url_verification handshake and a setup prompt", () => {
    const source = webhookSource();
    expect(source).toMatchObject({ provider: "slack", secretProvisioning: "provider" });
    expect(source.verifier).toMatchObject({
      kind: "config",
      handshake: { matchPath: "type", matchValue: "url_verification" },
      response: { acceptedBody: "empty" },
    });
    expect(source.setupPrompt).toContain("Event Subscriptions");
    expect(source.setupPrompt).toContain("Interactivity");
    expect(slackEvents).toEqual({ id: "slack-test", source: "slack" });
  });

  it("types a slash command endpoint, so filters and handlers read the command's form fields", () => {
    const commands = webhooks.endpoint.define({
      id: "slack-commands-test",
      source: webhookSource<SlackSlashCommand>(),
    });
    const deploy = webhook({
      id: "slack-test.deploy-command",
      endpoint: commands,
      filter: "event.command == '/deploy'",
      onEvent: async ({ event }) => {
        void event.response_url;
      },
    });
    expect(deploy.id).toBe("slack-test.deploy-command");
  });

  it("refuses a connector without an endpoint, or on a non-Slack endpoint", () => {
    expect(() =>
      slack({ startOn: "event.event.type == 'message'", id: "s-none", token: "t" } as never)
    ).toThrow('slack("s-none"): an endpoint is required');
    const stripe = webhooks.endpoint.define({ id: "slack-test-stripe", source: webhooks.stripe() });
    expect(() =>
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: stripe as never,
        id: "s-wrong",
        token: "t",
      })
    ).toThrow('endpoint "slack-test-stripe" has source "stripe"');
  });

  it("subscribes the connector to the endpoint", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-sub",
      token: "t",
    });
    expect(c.endpointId).toBe("slack-test");
    expect(c.source).toBe("slack");
  });
});

describe("slack channel", () => {
  it("default inbound strips a leading bot mention and attributes the message", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s1",
      token: "xoxb-t",
    });
    expect(c.inbound(messageEvent({ text: "<@U123> hello there", user: "U77" }))).toEqual({
      message: "hello there",
      externalUserId: "U77",
      externalMessageId: "1699999999.0001",
    });
    expect((c.inbound(messageEvent({ text: "plain" })) as { message: string }).message).toBe(
      "plain"
    );
  });

  it("binds a session to the event's thread and the user it answers", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-bind",
      token: "t",
    });
    expect(c.bind!(messageEvent({ thread_ts: "1699999999.0000" }))).toEqual({
      channel: "C9",
      threadTs: "1699999999.0000",
    });
    expect(c.bind!(messageEvent())).toEqual({ channel: "C9", threadTs: "1699999999.0001" });
    expect(
      c.bind!({
        ...messageEvent({ user: "U7", user_team: "T2" }),
        team_id: "T1",
      } as unknown as SlackMessageEvent)
    ).toEqual({
      teamId: "T1",
      channel: "C9",
      threadTs: "1699999999.0001",
      userId: "U7",
      userTeamId: "T2",
    });
    expect(
      c.bind!({ ...messageEvent({ user: "U7", user_team: "T1" }), team_id: "T1" } as never)
    ).toEqual({ teamId: "T1", channel: "C9", threadTs: "1699999999.0001", userId: "U7" });
    expect(c.bind!({ type: "event_callback", event: { type: "message" } })).toBeNull();
  });

  it("send posts into the bound thread when no event started the turn, resolving the token from the handle", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.0009" }));
    const seenTeams: unknown[] = [];
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-bound",
      token: async (event) => {
        seenTeams.push((event as { team_id?: string }).team_id);
        return "xoxb-from-handle";
      },
      apiBaseUrl: "https://mock.slack",
    });

    const res = await c.send!(
      { text: "your order **shipped**" },
      {
        handle: { teamId: "T9", channel: "C9", threadTs: "1699999999.0001" },
        mode: "final",
        final: true,
        bound: true,
      }
    );
    expect(res.ref).toBe("1700000000.0009");
    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.auth).toBe("Bearer xoxb-from-handle");
    expect(calls[0]?.body).toEqual({
      channel: "C9",
      thread_ts: "1699999999.0001",
      markdown_text: "your order **shipped**",
    });
    expect(seenTeams).toEqual(["T9"]);

    await expect(
      c.send!({ text: "nowhere" }, { mode: "final", final: true, bound: true })
    ).rejects.toThrow(/no thread to post into/);

    vi.unstubAllGlobals();
  });

  it("composes the self-message guard with a user filter, and always admits its own approval clicks", () => {
    const guardOnly = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s2",
      token: "t",
    });
    expect(guardOnly.filter).toContain("event.event.type == 'message'");
    expect(guardOnly.filter).toContain("event.event.bot_id == null");
    expect(guardOnly.filter).toContain(
      "event.event.subtype in [null,'file_share','thread_broadcast']"
    );
    expect(guardOnly.filter).toContain("event.type == 'block_actions'");

    const withUser = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s3",
      token: "t",
      filter: "event.event.channel == 'C1'",
    });
    expect(withUser.filter).toContain("&& (event.event.channel == 'C1')");
    expect(withUser.filter).toContain("event.type == 'block_actions'");
    // The stop button is admitted ahead of the user's message filter.
    expect(withUser.filter).toBe(
      "event.type == 'block_actions' && event.actions any ( action_id startsWith 'trigger_' ) || event.event.type == 'agent_session_stopped' || (event.event.type == 'message' && event.event.bot_id == null && event.event.subtype in [null,'file_share','thread_broadcast'] && (event.event.channel == 'C1'))"
    );
  });

  it("keys one session per thread, converging message events and interactivity", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s4",
      token: "t",
    });
    expect(c.key).toBe(
      "{body.team_id || body.team.id}:{body.event.channel || body.container.channel_id}:{body.event.thread_ts || body.event.ts || body.container.thread_ts || body.message.thread_ts || body.container.message_ts}"
    );
  });

  it("renderInteraction produces Block Kit approve/deny buttons carrying the toolCallId", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-hitl",
      token: "t",
    });
    const msg = c.renderInteraction?.(
      [{ toolCallId: "call-1", toolName: "requestApproval", input: { amount: 50 } }],
      {
        event: messageEvent(),
        deliveryId: "d1",
      }
    );
    expect(msg).not.toBeNull();
    const values = (msg!.blocks as any[]).flatMap((b) => b.elements ?? []).map((e: any) => e.value);
    expect(values).toContain(toolValue("call-1", { approved: true }));
    expect(values).toContain(toolValue("call-1", { approved: false }));
  });

  it("renderInteraction truncates an oversized tool input to stay under the Slack block limit", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-hitl-big",
      token: "t",
    });
    const msg = c.renderInteraction?.(
      [
        {
          toolCallId: "call-big",
          toolName: "requestApproval",
          input: { blob: "x".repeat(10_000) },
        },
      ],
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect(msg).not.toBeNull();
    const section = (msg!.blocks as any[]).find((b) => b.type === "section");
    const text = section.text.text as string;
    expect(text).toContain("... (truncated)");
    expect(text.length).toBeLessThan(3000);
  });

  it("renderInteraction posts controls for every pending tool call, not just the first", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-hitl-multi",
      token: "t",
    });
    const msg = c.renderInteraction?.(
      [
        { toolCallId: "call-a", toolName: "refund", input: { amount: 1 } },
        { toolCallId: "call-b", toolName: "sendEmail", input: { to: "x" } },
      ],
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect(msg).not.toBeNull();
    const values = (msg!.blocks as any[]).flatMap((b) => b.elements ?? []).map((e: any) => e.value);
    expect(values).toEqual([
      toolValue("call-a", { approved: true }),
      toolValue("call-a", { approved: false }),
      toolValue("call-b", { approved: true }),
      toolValue("call-b", { approved: false }),
    ]);
    const ids = (msg!.blocks as any[])
      .flatMap((b) => b.elements ?? [])
      .map((e: any) => e.action_id);
    expect(new Set(ids).size).toBe(4);
  });

  it("onInteraction resolves a block_actions click to a tool output; ignores messages", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-hitl2",
      token: "t",
    });
    const approve = c.onInteraction?.({
      type: "block_actions",
      actions: [{ action_id: "trigger_tool_0", value: toolValue("call-9", { approved: true }) }],
    } as never);
    expect(approve).toEqual({ toolCallId: "call-9", output: { approved: true } });

    const picked = c.onInteraction?.({
      type: "block_actions",
      actions: [{ action_id: "trigger_tool_3", value: toolValue("call-9", { picked: "wizard" }) }],
    } as never);
    expect(picked).toEqual({ toolCallId: "call-9", output: { picked: "wizard" } });

    const otherButton = c.onInteraction?.({
      type: "block_actions",
      actions: [{ action_id: "open_ticket", value: toolValue("call-9", { approved: true }) }],
    } as never);
    expect(otherButton).toBeNull();

    const actionButton = c.onInteraction?.({
      type: "block_actions",
      actions: [{ action_id: "trigger_action_abc", value: '{"type":"explain"}' }],
    } as never);
    expect(actionButton).toBeNull();

    expect(c.onInteraction?.(messageEvent())).toBeNull();
  });

  it("finalizeInteraction replaces the controls via response_url, dropping the buttons", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return Response.json({ ok: true });
      })
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-fin",
      token: "t",
    });
    await c.finalizeInteraction?.(
      {
        type: "block_actions",
        user: { id: "U42" },
        response_url: "https://hooks.slack.com/actions/T1/1/abc",
        actions: [
          {
            action_id: "trigger_tool_0",
            value: toolValue("call-1", { approved: true }),
            text: { text: "Approve" },
          },
        ],
        message: {
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "Approval needed" } },
            {
              type: "actions",
              elements: [{ type: "button", value: toolValue("call-1", { approved: true }) }],
            },
          ],
        },
      } as never,
      { toolCallId: "call-1", output: { approved: true } }
    );
    expect(calls[0]?.url).toBe("https://hooks.slack.com/actions/T1/1/abc");
    expect(calls[0]?.body.replace_original).toBe(true);
    const types = (calls[0]!.body.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain("actions");
    expect(JSON.stringify(calls[0]?.body.blocks)).toContain("Approved");
    vi.unstubAllGlobals();
  });

  it("finalizeInteraction throws when Slack rejects the edit, so the runtime logs it", async () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-fin-fail",
      token: "t",
    });
    const click = {
      type: "block_actions",
      response_url: "https://hooks.slack.com/actions/T1/1/abc",
      actions: [{ value: toolValue("call-1", { approved: true }) }],
    } as never;
    for (const answer of [
      new Response("rate limited", { status: 429 }),
      Response.json({ ok: false, error: "expired_url" }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer)
      );
      await expect(
        c.finalizeInteraction?.(click, { toolCallId: "call-1", output: { approved: true } })
      ).rejects.toThrow(/approval message failed/);
    }
    vi.unstubAllGlobals();
  });

  it("finalizeInteraction is a no-op without a response_url", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-fin2",
      token: "t",
    });
    await c.finalizeInteraction?.(
      { type: "block_actions", actions: [{ value: toolValue("x", { approved: false }) }] } as never,
      { toolCallId: "x", output: { approved: false } }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("finalizeInteraction only posts to a hooks.slack.com response_url", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-fin3",
      token: "t",
    });
    for (const response_url of [
      "https://evil.example.com/collect",
      "http://hooks.slack.com/actions/T1/1/abc",
      "https://hooks.slack.com.evil.example/actions/T1/1/abc",
      "not a url",
    ]) {
      await c.finalizeInteraction?.(
        {
          type: "block_actions",
          response_url,
          actions: [{ value: toolValue("x", { approved: true }) }],
        } as never,
        { toolCallId: "x", output: { approved: true } }
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isSlackResponseUrl("https://hooks.slack.com/actions/T1/1/abc")).toBe(true);
    expect(isSlackResponseUrl("https://hooks.slack-gov.com/actions/T1/1/abc")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("never starts a session from a click or a stop, and applies a user's startOn to channels only", () => {
    const every = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s5",
      token: "t",
    });
    expect(every.startOn).toBe(
      "event.type != 'block_actions' && event.event.type != 'agent_session_stopped' && (event.event.channel_type == 'im' || (event.event.type == 'message'))"
    );

    const summon = slack({
      endpoint: slackEvents,
      id: "s6",
      token: "t",
      startOn: mentions("U012BOT"),
    });
    expect(summon.startOn).toBe(
      "event.type != 'block_actions' && event.event.type != 'agent_session_stopped' && (event.event.channel_type == 'im' || ((event.event.text contains '<@U012BOT>' || event.event.text contains '<@U012BOT|')))"
    );
  });

  it("appMentions() starts sessions from app_mention events and admits them past the guard", () => {
    const c = slack({
      endpoint: slackEvents,
      id: "s-app-mention",
      token: "t",
      startOn: appMentions(),
    });
    expect(appMentions()).toBe("event.event.type == 'app_mention'");
    expect(c.startOn).toBe(
      "event.type != 'block_actions' && event.event.type != 'agent_session_stopped' && (event.event.channel_type == 'im' || (event.event.type == 'app_mention'))"
    );
    expect(c.filter).toContain("(event.event.type == 'app_mention' && event.event.bot_id == null)");
    const plain = slack({
      endpoint: slackEvents,
      id: "s-mentions",
      token: "t",
      startOn: mentions("UBOT"),
    });
    expect(plain.filter).not.toContain("app_mention");
  });

  it("with appMentions(), ignores the channel message copy of a mention and keeps the rest", () => {
    const c = slack({
      endpoint: slackEvents,
      id: "s-app-copy",
      token: "t",
      startOn: appMentions(),
    });
    const withBot = (event: SlackMessageEvent) =>
      ({ ...event, authorizations: [{ user_id: "UBOT" }] }) as SlackMessageEvent;
    const text = (event: SlackMessageEvent) => c.inbound(withBot(event)).message;

    expect(text(messageEvent({ text: "<@UBOT> deploy status?", channel_type: "channel" }))).toBe(
      ""
    );
    expect(text(messageEvent({ text: "thanks <@UBOT|bot>", channel_type: "group" }))).toBe("");
    expect(
      text(
        messageEvent({
          type: "app_mention",
          text: "<@UBOT> deploy status?",
          channel_type: undefined,
        })
      )
    ).toBe("deploy status?");
    expect(text(messageEvent({ text: "and staging?", channel_type: "channel" }))).toBe(
      "and staging?"
    );
    expect(text(messageEvent({ text: "<@UBOT> in a DM", channel_type: "im" }))).toBe("in a DM");
    expect(text(messageEvent({ text: "look at this <@UOTHER>", channel_type: "channel" }))).toBe(
      "look at this <@UOTHER>"
    );

    const plain = slack({
      endpoint: slackEvents,
      id: "s-mentions-copy",
      token: "t",
      startOn: mentions("UBOT"),
    });
    expect(
      plain.inbound(
        withBot(messageEvent({ text: "<@UBOT> deploy status?", channel_type: "channel" }))
      ).message
    ).toBe("deploy status?");
  });

  it("ownWorkspaceOnly drops messages and clicks from other workspaces", () => {
    const own = slack({
      endpoint: slackEvents,
      id: "s-own",
      token: "t",
      startOn: appMentions(),
      ownWorkspaceOnly: true,
    });
    expect(own.filter).toContain(
      "(event.event.user_team == null || event.event.user_team == event.team_id)"
    );
    expect(own.filter).toContain(
      "(event.user.team_id == null || event.user.team_id == event.team.id)"
    );
    const open = slack({ endpoint: slackEvents, id: "s-open", token: "t", startOn: appMentions() });
    expect(open.filter).not.toContain("user_team");
  });

  it("readableToolName turns a tool name into a task title", () => {
    expect(readableToolName("searchArchive")).toBe("Search archive");
    expect(readableToolName("search_archive")).toBe("Search archive");
    expect(readableToolName("search-archive")).toBe("Search archive");
    expect(readableToolName("getURLStatus")).toBe("Get URL status");
    expect(readableToolName("lookup")).toBe("Lookup");
  });

  it("requires startOn, so a channel agent never answers every message by default", () => {
    expect(() =>
      slack({ endpoint: slackEvents, id: "s-no-start", token: "t" } as unknown as Parameters<
        typeof slack
      >[0])
    ).toThrow(/startOn is required/);
  });

  it("maps the stop button to a stop that is dropped when idle and dated for stale checks", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-stop",
      token: "t",
    });
    const stop = {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "agent_session_stopped",
        channel: "D1",
        thread_ts: "1699999999.0001",
        user: "U7",
        event_ts: "1700000000.250000",
        streaming_message_ts: ["1700000000.1"],
      },
    } as SlackMessageEvent;
    expect(c.onControl!(stop)).toEqual({
      kind: "stop",
      message: "stopped from Slack",
      whenIdle: "drop",
      at: 1700000000250,
    });
    expect(c.onControl!(messageEvent())).toBeNull();
    expect(c.ack).toBeUndefined();
    expect(c.delivery).toBe("stream");
    expect(
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-final",
        token: "t",
        delivery: "final",
      }).stream
    ).toBeUndefined();
    expect(c.errorMessage).toBeUndefined();
    expect(
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-error",
        token: "t",
        errorMessage: "Couldn't answer.",
      }).errorMessage
    ).toBe("Couldn't answer.");
    const errorLine = ({ event, runId }: { event?: { team_id?: string }; runId?: string }) =>
      `Couldn't answer in ${event?.team_id} (ref ${runId}).`;
    expect(
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-error-fn",
        token: "t",
        errorMessage: errorLine,
      }).errorMessage
    ).toBe(errorLine);
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

  it("toSlackMrkdwn leaves fenced code blocks and inline code untouched", () => {
    const diff = "```diff\n- removed **line**\n+ added __line__\n```";
    expect(toSlackMrkdwn(`Here is the change:\n\n${diff}\n\n- next step`)).toBe(
      `Here is the change:\n\n${diff}\n\n• next step`
    );
    expect(toSlackMrkdwn("Run `npm run **build**` then see [docs](https://trigger.dev)")).toBe(
      "Run `npm run **build**` then see <https://trigger.dev|docs>"
    );
    expect(toSlackMrkdwn("```ts\nconst a = [x](y);\n- b\n")).toBe(
      "```ts\nconst a = [x](y);\n- b\n"
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

  it("send posts markdown as markdown_text, and blocks with text as the fallback", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.0001" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s5",
      token: "xoxb-secret",
      apiBaseUrl: "https://mock.slack",
    });
    const event = messageEvent();

    const res = await c.send!(
      { text: "# Done" },
      { event, deliveryId: "d1", mode: "stream", final: true, bound: false }
    );
    expect(res.ref).toBe("1700000000.0001");
    expect(calls[0]?.auth).toBe("Bearer xoxb-secret");
    expect(calls[0]?.body).toEqual({
      channel: "C9",
      thread_ts: "1699999999.0001",
      markdown_text: "# Done",
    });

    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Done*" } }];
    await c.send!(
      { text: "Done", blocks },
      { event, deliveryId: "d1", mode: "stream", final: true, bound: false }
    );
    expect(calls[1]?.body).toEqual({
      channel: "C9",
      thread_ts: "1699999999.0001",
      text: "Done",
      blocks,
    });

    vi.unstubAllGlobals();
  });

  it("send targets the thread from a block_actions payload (HITL resume egress)", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.9" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-resume",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    const interaction = {
      type: "block_actions",
      team: { id: "T1" },
      container: {
        type: "message",
        channel_id: "C42",
        thread_ts: "1699999999.0001",
        message_ts: "1700000000.5",
      },
      actions: [{ value: toolValue("call-1", { approved: true }) }],
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

  it("a click whose container omits thread_ts answers in the clicked message's thread, with the token for team.id", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.9" }));
    const seenTeams: unknown[] = [];
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-resume-2",
      token: (event) => {
        seenTeams.push((event as { team_id?: string }).team_id);
        return "xoxb-t1";
      },
      apiBaseUrl: "https://mock.slack",
    });
    const interaction = {
      type: "block_actions",
      team: { id: "T1" },
      container: { type: "message", channel_id: "C42", message_ts: "1700000000.5" },
      message: { ts: "1700000000.5", thread_ts: "1699999999.0001" },
      actions: [{ action_id: "trigger_tool_0", value: toolValue("call-1", { approved: true }) }],
    };
    await c.send!(
      { text: "refund approved" },
      { event: interaction as never, deliveryId: "d-resume-2", mode: "final", final: true }
    );
    expect(calls[0]?.body.thread_ts).toBe("1699999999.0001");
    expect(seenTeams).toEqual(["T1"]);
    vi.unstubAllGlobals();
  });

  it("send throws when the bot is not in the channel", async () => {
    mockSlack(() => ({ ok: false, error: "not_in_channel" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s6",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await expect(
      c.send!({ text: "x" }, { event: messageEvent(), deliveryId: "d", mode: "final", final: true })
    ).rejects.toThrow(/not_in_channel/);
    vi.unstubAllGlobals();
  });

  it("react adds/removes an emoji on the triggering message (colons stripped)", async () => {
    const calls = mockSlack();
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s7",
      token: "xoxb-secret",
      apiBaseUrl: "https://mock.slack",
    });

    await c.react!({ name: "eyes" }, { event: messageEvent(), deliveryId: "d1" });
    expect(calls[0]?.method).toBe("reactions.add");
    expect(calls[0]?.body).toMatchObject({
      channel: "C9",
      timestamp: "1699999999.0001",
      name: "eyes",
    });

    await c.react!(
      { name: ":white_check_mark:", remove: true },
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect(calls[1]?.method).toBe("reactions.remove");
    expect(calls[1]?.body.name).toBe("white_check_mark");
    vi.unstubAllGlobals();
  });

  it("react swallows already_reacted (idempotent)", async () => {
    mockSlack(() => ({ ok: false, error: "already_reacted" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s8",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await expect(
      c.react!({ name: "eyes" }, { event: messageEvent(), deliveryId: "d1" })
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("toSlackBlocks keeps a short answer in one section and converts to mrkdwn", () => {
    const blocks = toSlackBlocks("## Title\n\nSome **bold** text.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.text).toBe("*Title*\n\nSome *bold* text.");
  });

  it("toSlackBlocks splits at paragraph boundaries and never inside a code fence", () => {
    const code =
      "```ts\n" +
      Array.from({ length: 40 }, (_, i) => `const line${i} = ${"x".repeat(60)};`).join("\n") +
      "\n```";
    const md = `Intro paragraph.\n\n${code}\n\nOutro paragraph.`;
    const blocks = toSlackBlocks(md, { maxChars: 1200 });
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.text.text.length).toBeLessThanOrEqual(1200);
      // every section has balanced fences
      expect((b.text.text.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(blocks[0]!.text.text.startsWith("Intro paragraph.")).toBe(true);
    expect(blocks[blocks.length - 1]!.text.text.endsWith("Outro paragraph.")).toBe(true);
    // a continued fence reopens with its language
    const continued = blocks.slice(1).find((b) => b.text.text.includes("const line"));
    expect(continued?.text.text.startsWith("```ts\n")).toBe(true);
  });

  it("toSlackBlocks rejects a maxChars that leaves no room to split", () => {
    expect(() => toSlackBlocks("hello", { maxChars: 0 })).toThrow(RangeError);
    expect(() => toSlackBlocks("hello", { maxChars: -5 })).toThrow(RangeError);
    expect(() => toSlackBlocks("hello", { maxChars: 12.5 })).toThrow(RangeError);
  });

  it("toSlackBlocks keeps every piece of an oversized code line inside a balanced fence", () => {
    const md = "```ts\n" + "x".repeat(6000) + "\n```";
    const blocks = toSlackBlocks(md, { maxChars: 1000 });
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      const text = block.text.text;
      expect(text.length).toBeLessThanOrEqual(1000);
      expect(text.startsWith("```ts\n")).toBe(true);
      expect(text.endsWith("\n```")).toBe(true);
    }
    const body = blocks
      .map((b) => b.text.text.replace(/^```ts\n/, "").replace(/\n```$/, ""))
      .join("");
    expect(body).toBe("x".repeat(6000));
  });

  it("default inbound strips a labelled bot mention too", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s1",
      token: "xoxb-t",
    });
    expect(
      (
        c.inbound(messageEvent({ text: "<@U123|triage-bot> hello there", user: "U77" })) as {
          message: string;
        }
      ).message
    ).toBe("hello there");
  });

  it("default inbound maps shared images and PDFs to file parts on their Slack URLs, and other files to notes", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-files",
      token: "xoxb-t",
    });
    const url = (name: string) => `https://files.slack.com/files-pri/T1-F1/${name}`;
    const inbound = c.inbound(
      messageEvent({
        subtype: "file_share",
        text: "<@U123> what do these say?",
        user: "U77",
        files: [
          { name: "chart.png", mimetype: "image/png", size: 40_000, url_private: url("chart.png") },
          {
            name: "photo.jpg",
            mimetype: "image/jpeg",
            size: 9_000_000,
            url_private: url("photo.jpg"),
            thumb_1024: url("photo_1024.jpg"),
          },
          {
            name: "huge.gif",
            mimetype: "image/gif",
            size: 9_000_000,
            url_private: url("huge.gif"),
          },
          {
            name: "q3.pdf",
            mimetype: "application/pdf",
            size: 900_000,
            url_private: url("q3.pdf"),
          },
          { name: "data.zip", mimetype: "application/zip", size: 10, url_private: url("data.zip") },
          { name: "gone.png", mimetype: "image/png", mode: "tombstone" },
        ],
      })
    );
    expect(inbound).toEqual({
      message: {
        id: "",
        role: "user",
        parts: [
          { type: "text", text: "what do these say?" },
          { type: "file", mediaType: "image/png", url: url("chart.png"), filename: "chart.png" },
          {
            type: "file",
            mediaType: "image/jpeg",
            url: url("photo_1024.jpg"),
            filename: "photo.jpg",
          },
          {
            type: "text",
            text: '[Attached file "huge.gif" (image/gif) is not available to you: it is too large]',
          },
          { type: "file", mediaType: "application/pdf", url: url("q3.pdf"), filename: "q3.pdf" },
          {
            type: "text",
            text: '[Attached file "data.zip" (application/zip) is not available to you: the model cannot read this file type]',
          },
          {
            type: "text",
            text: '[Attached file "gone.png" (image/png) is not available to you: the app cannot read it]',
          },
        ],
      },
      externalUserId: "U77",
      externalMessageId: "1699999999.0001",
    });

    const fileOnly = c.inbound(
      messageEvent({
        subtype: "file_share",
        text: "",
        files: [{ name: "a.png", mimetype: "image/png", size: 1, url_private: url("a.png") }],
      })
    ) as { message: { parts: unknown[] } };
    expect(fileOnly.message.parts).toEqual([
      { type: "file", mediaType: "image/png", url: url("a.png"), filename: "a.png" },
    ]);
  });

  it("slackFileParts maps a message's files for a custom inbound", () => {
    expect(slackFileParts(undefined)).toEqual([]);
    expect(
      slackFileParts([
        {
          name: "a.png",
          mimetype: "image/png",
          size: 10,
          url_private: "https://files.slack.com/a.png",
        },
        {
          name: "b.zip",
          mimetype: "application/zip",
          size: 10,
          url_private: "https://files.slack.com/b.zip",
        },
      ])
    ).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        url: "https://files.slack.com/a.png",
        filename: "a.png",
      },
      {
        type: "text",
        text: '[Attached file "b.zip" (application/zip) is not available to you: the model cannot read this file type]',
      },
    ]);
  });

  it("download fetches a Slack file with the bot token for the session's workspace, and ignores other URLs", async () => {
    const requests: { url: string; auth: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: { headers: Record<string, string> }) => {
        requests.push({ url: String(url), auth: init.headers.authorization });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      })
    );
    const teams: unknown[] = [];
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-download",
      token: async (event) => {
        teams.push((event as { team_id?: string }).team_id);
        return "xoxb-files";
      },
    });
    const handle = { teamId: "T9", channel: "C9", threadTs: "1699999999.0001" };

    const file = await c.download!(new URL("https://files.slack.com/files-pri/T9-F1/a.png"), {
      handle,
    });
    expect(file).toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
    expect(requests).toEqual([
      { url: "https://files.slack.com/files-pri/T9-F1/a.png", auth: "Bearer xoxb-files" },
    ]);
    expect(teams).toEqual(["T9"]);

    expect(await c.download!(new URL("https://example.com/a.png"), { handle })).toBeNull();
    expect(
      await c.download!(new URL("http://files.slack.com/files-pri/T9-F1/a.png"), { handle })
    ).toBeNull();
    expect(requests).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("download throws on Slack's sign-in page (no files:read scope) and on a failed request", async () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-download-errors",
      token: "xoxb-t",
    });
    const url = new URL("https://files.slack.com/files-pri/T9-F1/a.png");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }))
    );
    await expect(c.download!(url, {})).rejects.toThrow(/files:read/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    await expect(c.download!(url, {})).rejects.toThrow(/404/);
    vi.unstubAllGlobals();
  });

  it("seedFromThread notes the files shared earlier in the thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: "1.000",
              user: "U1",
              text: "",
              subtype: "file_share",
              files: [{ name: "q3.pdf" }],
            },
            { ts: "2.000", user: "U1", text: "<@UBOT> summarize it" },
          ],
        }),
      }))
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed-files",
      token: "xoxb-t",
      apiBaseUrl: "https://mock.slack",
      seedFromThread: true,
    });
    const event = {
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "message",
        channel: "C9",
        ts: "2.000",
        thread_ts: "1.000",
        text: "<@UBOT> summarize it",
        user: "U1",
      },
    } as unknown as SlackMessageEvent;
    expect(await c.seed!(event, { event, deliveryId: "d1" })).toEqual([
      {
        role: "user",
        text: '<@U1>: [Attached file "q3.pdf"]',
        externalMessageId: "1.000",
        externalUserId: "U1",
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("marks a message received mid-reply with eyes by default, a custom emoji, or nothing", async () => {
    const calls = mockSlack();
    const steer = {
      event: messageEvent({ ts: "1700000000.0007" }),
      deliveryId: "d1",
      bound: false,
    };
    await slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-steer",
      token: "t",
    }).received!(steer as never);
    await slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-steer2",
      token: "t",
      receivedReaction: "inbox_tray",
    }).received!(steer as never);
    expect(calls.map((c) => [c.method, c.body.name, c.body.timestamp])).toEqual([
      ["reactions.add", "eyes", "1700000000.0007"],
      ["reactions.add", "inbox_tray", "1700000000.0007"],
    ]);
    expect(
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-steer3",
        token: "t",
        receivedReaction: null,
      }).received
    ).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("renders a tool's own UI from interactions, and its click resolves the tool with the button's output", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-ui",
      token: "t",
      interactions: {
        pickEmoji: (call, { button }) => ({
          text: "Pick one",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "Which one?" } },
            {
              type: "actions",
              elements: (call.input as { options: string[] }).options.map((name) =>
                button({ text: `:${name}:`, output: { picked: name } })
              ),
            },
          ],
        }),
      },
    });
    const msg = c.renderInteraction?.(
      [
        { toolCallId: "call-pick", toolName: "pickEmoji", input: { options: ["wizard", "cat"] } },
        { toolCallId: "call-refund", toolName: "refund", input: { amount: 5 } },
      ],
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect(msg?.text).toBe("2 tool calls are waiting for an answer");
    const buttons = (msg!.blocks as any[]).flatMap((b) => b.elements ?? []);
    expect(buttons.map((b: any) => [b.action_id, b.text.text, b.value])).toEqual([
      ["trigger_tool_0", ":wizard:", toolValue("call-pick", { picked: "wizard" })],
      ["trigger_tool_1", ":cat:", toolValue("call-pick", { picked: "cat" })],
      ["trigger_tool_2", "Approve", toolValue("call-refund", { approved: true })],
      ["trigger_tool_3", "Deny", toolValue("call-refund", { approved: false })],
    ]);

    const click = { type: "block_actions", actions: [buttons[1]] } as never;
    expect(c.onInteraction?.(click)).toEqual({
      toolCallId: "call-pick",
      output: { picked: "cat" },
    });
    expect(c.toAction?.(click)).toBeNull();
  });

  it("a custom approval replaces the default Approve and Deny", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-approval",
      token: "t",
      approval: (call, { button }) => ({
        text: `Run ${call.toolName}?`,
        blocks: [
          {
            type: "actions",
            elements: [
              button({
                text: "Ship it",
                style: "primary",
                output: { approved: true },
                confirm: { title: "Sure?", text: "This deploys." },
              }),
              button({ text: "Not now", output: { approved: false } }),
            ],
          },
        ],
      }),
    });
    const msg = c.renderInteraction?.([{ toolCallId: "call-1", toolName: "deploy", input: {} }], {
      event: messageEvent(),
      deliveryId: "d1",
    });
    expect(msg?.text).toBe("Run deploy?");
    const [ship, notNow] = (msg!.blocks as any[])[0].elements;
    expect(ship.text.text).toBe("Ship it");
    expect(ship.confirm.title.text).toBe("Sure?");
    expect(ship.confirm.confirm.text).toBe("Confirm");
    expect(notNow.value).toBe(toolValue("call-1", { approved: false }));
  });

  it("posts a note in place of controls a renderer fails to build, including an oversized output", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-ui-errors",
      token: "t",
      interactions: {
        broken: () => {
          throw new Error("boom");
        },
        huge: (_call, { button }) => ({
          text: "Pick",
          blocks: [
            { type: "actions", elements: [button({ text: "x", output: "y".repeat(3000) })] },
          ],
        }),
      },
    });
    const msg = c.renderInteraction?.(
      [
        { toolCallId: "a", toolName: "broken", input: {} },
        { toolCallId: "b", toolName: "huge", input: {} },
      ],
      { event: messageEvent(), deliveryId: "d1" }
    );
    expect((msg!.blocks as any[]).map((b) => b.text.text)).toEqual([
      "`broken` is waiting for an answer, but its controls could not be shown.",
      "`huge` is waiting for an answer, but its controls could not be shown.",
    ]);
  });

  it("slackButton sends its action to the agent through toAction, and not as a tool answer", () => {
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-actions",
      token: "t",
    });
    const button = slackButton({ text: "Explain more", action: { type: "explain", depth: 2 } });
    expect(button.action_id).toMatch(/^trigger_action_[0-9a-f]{12}$/);
    const click = { type: "block_actions", actions: [button] } as never;
    expect(c.toAction?.(click)).toEqual({ type: "explain", depth: 2 });
    expect(c.onInteraction?.(click)).toBeNull();
    expect(c.toAction?.(messageEvent())).toBeNull();
    expect(() => slackButton({ text: "big", action: "z".repeat(2500) })).toThrow(/2000/);
  });

  it("finalizeInteraction shows the chosen button for a tool answer", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: JSON.parse(init.body) });
        return Response.json({ ok: true });
      })
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-fin-pick",
      token: "t",
    });
    const value = toolValue("call-pick", { picked: "wizard" });
    await c.finalizeInteraction?.(
      {
        type: "block_actions",
        user: { id: "U42" },
        response_url: "https://hooks.slack.com/actions/T1/1/abc",
        actions: [{ action_id: "trigger_tool_0", value, text: { text: ":wizard:" } }],
        message: {
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "Which one?" } },
            { type: "actions", elements: [{ type: "button", value }] },
          ],
        },
      } as never,
      { toolCallId: "call-pick", output: { picked: "wizard" } }
    );
    expect(calls[0]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Which one?" } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: ":white_check_mark: *:wizard:* by <@U42>" }],
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("the surface posts a message into the session's thread", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.0042" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-post",
      token: "xoxb-post",
      apiBaseUrl: "https://mock.slack",
    });
    const surface = c.surface!({
      handle: { teamId: "T9", channel: "C9", threadTs: "1699999999.0001" },
    } as never) as SlackSurface;
    const blocks = [
      { type: "actions", elements: [slackButton({ text: "More", action: { type: "more" } })] },
    ];
    expect(await surface.post({ text: "Anything else?", blocks })).toEqual({
      ts: "1700000000.0042",
    });
    expect(calls[0]).toEqual({
      method: "chat.postMessage",
      auth: "Bearer xoxb-post",
      body: { channel: "C9", thread_ts: "1699999999.0001", text: "Anything else?", blocks },
    });
    vi.unstubAllGlobals();
  });

  it("toSlackBlocks never exceeds the Slack section limit even for one giant paragraph", () => {
    const blocks = toSlackBlocks("word ".repeat(2000));
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(2900);
  });

  it("seedFromThread with limit 0 seeds nothing and never calls Slack; a negative limit is rejected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed-0",
      token: "xoxb-t",
      apiBaseUrl: "https://mock.slack",
      seedFromThread: { limit: 0 },
    });
    const event = {
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "message",
        channel: "C9",
        ts: "4.000",
        thread_ts: "1.000",
        text: "hi",
        user: "U1",
      },
    };
    expect(await c.seed!(event as never, { event: event as never, deliveryId: "d" })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() =>
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-seed-neg",
        token: "xoxb-t",
        seedFromThread: { limit: -1 },
      })
    ).toThrow(RangeError);
    expect(() =>
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-seed-frac",
        token: "xoxb-t",
        seedFromThread: { limit: 2.5 },
      })
    ).toThrow(RangeError);
  });

  it("seedFromThread loads the thread's prior replies, excluding the triggering message", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          json: async () => ({
            ok: true,
            messages: [
              { ts: "1.000", user: "U1", text: "please refund order 789" },
              { ts: "2.000", user: "UBOT", bot_id: "B1", text: "Approved by <@U1>" },
              {
                ts: "3.000",
                user: "UBOT",
                bot_id: "B1",
                text: "The refund for order 789 is complete.",
              },
              { ts: "4.000", user: "U1", text: "<@UBOT> it never arrived" },
              { ts: "5.000", user: "U2", text: "joined the channel", subtype: "channel_join" },
            ],
          }),
        };
      })
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed",
      token: "xoxb-t",
      apiBaseUrl: "https://mock.slack",
      seedFromThread: true,
    });
    const event = {
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "message",
        channel: "C9",
        ts: "4.000",
        thread_ts: "1.000",
        text: "<@UBOT> it never arrived",
        user: "U1",
      },
    } as unknown as SlackMessageEvent;
    const seeded = await c.seed!(event, { event, deliveryId: "d1" });
    expect(calls[0]).toContain(
      "https://mock.slack/conversations.replies?channel=C9&ts=1.000&limit=200"
    );
    expect(seeded).toEqual([
      {
        role: "user",
        text: "<@U1>: please refund order 789",
        externalMessageId: "1.000",
        externalUserId: "U1",
      },
      {
        role: "assistant",
        text: "Approved by <@U1>",
        externalMessageId: "2.000",
        externalUserId: "UBOT",
      },
      {
        role: "assistant",
        text: "The refund for order 789 is complete.",
        externalMessageId: "3.000",
        externalUserId: "UBOT",
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("seedFromThread walks every page of a long thread and keeps the newest replies", async () => {
    const calls: string[] = [];
    const page = (from: number, to: number, next?: string) => ({
      ok: true,
      messages: Array.from({ length: to - from + 1 }, (_, i) => ({
        ts: `${from + i}.000`,
        user: "U1",
        text: `message ${from + i}`,
      })),
      response_metadata: { next_cursor: next ?? "" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const cursor = new URL(url).searchParams.get("cursor");
        const body = !cursor ? page(1, 3, "c2") : cursor === "c2" ? page(4, 6, "c3") : page(7, 9);
        return { json: async () => body };
      })
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed-pages",
      token: "xoxb-t",
      apiBaseUrl: "https://mock.slack",
      seedFromThread: { limit: 3 },
    });
    const event = {
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "message",
        channel: "C9",
        ts: "9.000",
        thread_ts: "1.000",
        text: "message 9",
        user: "U1",
      },
    } as unknown as SlackMessageEvent;
    const seeded = await c.seed!(event, { event, deliveryId: "d1" });
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => new URL(url).searchParams.get("limit") === "200")).toBe(true);
    expect(calls[1]).toContain("cursor=c2");
    expect(calls[2]).toContain("cursor=c3");
    expect(seeded.map((m) => m.externalMessageId)).toEqual(["6.000", "7.000", "8.000"]);
    vi.unstubAllGlobals();
  });

  it("seedFromThread keeps what it has when Slack rate limits the next page", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return {
            status: 200,
            json: async () => ({
              ok: true,
              messages: [
                { ts: "1.000", user: "U1", text: "first" },
                { ts: "2.000", user: "U1", text: "second" },
              ],
              response_metadata: { next_cursor: "c2" },
            }),
          };
        }
        return {
          status: 429,
          headers: new Headers({ "retry-after": "60" }),
          json: async () => ({ ok: false, error: "ratelimited" }),
        };
      })
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed-429",
      token: "xoxb-t",
      apiBaseUrl: "https://mock.slack",
      seedFromThread: { limit: 10 },
    });
    const event = {
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "message",
        channel: "C9",
        ts: "9.000",
        thread_ts: "1.000",
        text: "x",
        user: "U1",
      },
    } as unknown as SlackMessageEvent;
    const seeded = await c.seed!(event, { event, deliveryId: "d1" });
    expect(call).toBe(2);
    expect(seeded.map((m) => m.externalMessageId)).toEqual(["1.000", "2.000"]);
    vi.unstubAllGlobals();
  });

  it("seedFromThread is off by default and ignores interactivity payloads", async () => {
    expect(
      slack({
        startOn: "event.event.type == 'message'",
        endpoint: slackEvents,
        id: "s-noseed",
        token: "t",
      }).seed
    ).toBeUndefined();
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-seed2",
      token: "t",
      seedFromThread: { limit: 5 },
    });
    const click = {
      type: "block_actions",
      container: { channel_id: "C9", thread_ts: "1.000" },
    } as unknown as SlackMessageEvent;
    expect(await c.seed!(click, { event: click, deliveryId: "d2" })).toEqual([]);
  });
});

describe("slack agent session status", () => {
  const handle = { teamId: "T1", channel: "D1", threadTs: "1699999999.0001", userId: "U7" };
  const turn = (over: Record<string, unknown> = {}) =>
    ({ handle, bound: true, firstTurn: false, ...over }) as never;

  it("maps the lifecycle to agents.sessions.setStatus, titling the session on its first turn", async () => {
    const calls = mockSlack();
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-status",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await c.lifecycle!(
      "working",
      turn({ firstTurn: true, prompt: "Why did my deploy fail?\nlogs attached" })
    );
    await c.lifecycle!("waiting", turn());
    await c.lifecycle!("working", turn({ prompt: "approve it" }));
    await c.lifecycle!("idle", turn());
    await c.lifecycle!("closed", turn());
    expect(calls.map((call) => call.method)).toEqual(Array(5).fill("agents.sessions.setStatus"));
    expect(calls.map((call) => call.body.status)).toEqual([
      "processing",
      "suspended",
      "processing",
      "active",
      "closed",
    ]);
    expect(calls[0]!.body).toEqual({
      channel_id: "D1",
      thread_ts: "1699999999.0001",
      status: "processing",
      title: "Why did my deploy fail?",
    });
    expect(calls[2]!.body.title).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("uses a custom title, leaves Slack's title on null, and caps it at 200 characters", async () => {
    const calls = mockSlack();
    const custom = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-title",
      token: "t",
      apiBaseUrl: "https://mock.slack",
      title: (prompt) => (prompt.startsWith("skip") ? null : `Support: ${prompt}`.repeat(20)),
    });
    await custom.lifecycle!("working", turn({ firstTurn: true, prompt: "refund" }));
    await custom.lifecycle!("working", turn({ firstTurn: true, prompt: "skip me" }));
    expect((calls[0]!.body.title as string).length).toBe(200);
    expect(calls[1]!.body.title).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("surfaces a refused status update so the runtime logs it", async () => {
    mockSlack(() => ({ ok: false, error: "not_authorized" }));
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-status-err",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await expect(c.lifecycle!("working", turn())).rejects.toThrow(/not_authorized/);
    vi.unstubAllGlobals();
  });
});

describe("slack native streaming", () => {
  const event = {
    ...messageEvent({ user: "U7", thread_ts: "1699999999.0000" }),
    team_id: "T1",
  } as SlackMessageEvent;
  const opened: string[] = [];
  const turn = {
    event,
    deliveryId: "d1",
    bound: false,
    opened: (ref: string) => opened.push(ref),
  } as never;
  const open = (over: Record<string, unknown> = {}) =>
    slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-stream",
      token: "t",
      apiBaseUrl: "https://mock.slack",
      ...over,
    }).stream!(turn)!;
  const texts = (call: SlackCall) =>
    ((call.body.chunks as Array<{ type: string; text?: string }> | undefined) ?? [])
      .filter((chunk) => chunk.type === "markdown_text")
      .map((chunk) => chunk.text)
      .join("");

  it("starts a stream for the recipient, appends batches of markdown, and stops it", async () => {
    const calls = mockSlack((call) =>
      call.method === "chat.startStream" ? { ok: true, ts: "1700000000.5" } : { ok: true }
    );
    const stream = open();
    stream.text("Hello ");
    await new Promise((r) => setTimeout(r, 350));
    stream.text("**world**");
    stream.text("!");
    expect(await stream.end({ stopped: false, pending: false })).toEqual({ delivered: true });

    expect(calls.map((c) => c.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(calls[0]!.body).toMatchObject({
      channel: "C9",
      thread_ts: "1699999999.0000",
      recipient_user_id: "U7",
      recipient_team_id: "T1",
      task_display_mode: "plan",
    });
    expect(texts(calls[0]!)).toBe("Hello ");
    expect(calls[1]!.body).toMatchObject({ channel: "C9", ts: "1700000000.5" });
    expect(texts(calls[1]!)).toBe("**world**!");
    expect(calls[2]!.body).toEqual({ channel: "C9", ts: "1700000000.5" });
    expect(opened.at(-1)).toBe("1700000000.5");
    vi.unstubAllGlobals();
  });

  it("ends a stream a dead worker left open, ignoring one Slack already closed", async () => {
    const calls = mockSlack((_call, index) =>
      index === 0 ? { ok: true } : { ok: false, error: "message_not_in_streaming_state" }
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-interrupted",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    const ctx = {
      handle: { teamId: "T1", channel: "C9", threadTs: "1699999999.0001" },
      bound: true,
    } as never;
    await c.endInterruptedStream!("1700000000.5", ctx);
    await expect(c.endInterruptedStream!("1700000000.5", ctx)).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("chat.stopStream");
    expect(calls[0]!.body).toMatchObject({ channel: "C9", ts: "1700000000.5" });
    expect(JSON.stringify(calls[0]!.body.chunks)).toContain("Interrupted");
    vi.unstubAllGlobals();
  });

  it("streams a bound turn (no Slack event) to the bound thread and user", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const bound = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-stream-bound",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    }).stream!({
      handle: {
        teamId: "T1",
        channel: "C9",
        threadTs: "1699999999.0000",
        userId: "U7",
        userTeamId: "T2",
      },
      bound: true,
      opened: () => {},
    } as never)!;
    bound.text("order shipped");
    await bound.end({ stopped: false, pending: false });
    expect(calls[0]!.body).toMatchObject({
      channel: "C9",
      thread_ts: "1699999999.0000",
      recipient_user_id: "U7",
      recipient_team_id: "T2",
    });
    vi.unstubAllGlobals();
  });

  it("keeps the bound user as the recipient when a click starts the turn", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const click = {
      type: "block_actions",
      team: { id: "T1" },
      container: { channel_id: "C9", thread_ts: "1699999999.0000", message_ts: "1700000000.2" },
      actions: [{ value: toolValue("tc", { approved: true }) }],
    };
    const stream = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-stream-click",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    }).stream!({
      event: click,
      handle: { teamId: "T1", channel: "C9", threadTs: "1699999999.0000", userId: "U7" },
      bound: false,
      opened: () => {},
    } as never)!;
    stream.text("done");
    await stream.end({ stopped: false, pending: false });
    expect(calls[0]!.body).toMatchObject({ thread_ts: "1699999999.0000", recipient_user_id: "U7" });
    vi.unstubAllGlobals();
  });

  it("shows tool calls as task cards and marks unfinished ones on a stop", async () => {
    const calls = mockSlack((call) =>
      call.method === "chat.startStream" ? { ok: true, ts: "1700000000.5" } : { ok: true }
    );
    const stream = open({ progress: "tasks" });
    stream.progress!({ type: "tool-call", toolCallId: "tc1", toolName: "searchDocs", input: {} });
    stream.progress!({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "searchDocs",
      output: {},
    });
    stream.progress!({ type: "tool-call", toolCallId: "tc2", toolName: "runQuery", input: {} });
    stream.text("Looking");
    await stream.end({ stopped: true, pending: false });

    expect(calls[0]!.body.chunks).toEqual([
      { type: "task_update", id: "tc1", title: "Search docs", status: "in_progress" },
      { type: "task_update", id: "tc1", title: "Search docs", status: "complete" },
      { type: "task_update", id: "tc2", title: "Run query", status: "in_progress" },
      { type: "markdown_text", text: "Looking" },
    ]);
    expect(calls[0]!.body.task_display_mode).toBe("timeline");
    expect(calls[1]!.method).toBe("chat.stopStream");
    expect(calls[1]!.body.chunks).toEqual([
      { type: "task_update", id: "tc2", title: "Run query", status: "error", details: "Stopped" },
    ]);
    vi.unstubAllGlobals();
  });

  it("groups tool calls in a plan by default, titled by the tool's title, and marks it done", async () => {
    const calls = mockSlack((call) =>
      call.method === "chat.startStream" ? { ok: true, ts: "1700000000.5" } : { ok: true }
    );
    const stream = open();
    stream.progress!({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "searchArchive",
      title: "Search the archive",
      input: {},
    });
    stream.progress!({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "searchArchive",
      title: "Search the archive",
      output: {},
    });
    stream.text("Found it.");
    await stream.end({ stopped: false, pending: false });

    expect(calls[0]!.body.task_display_mode).toBe("plan");
    expect(calls[0]!.body.chunks).toEqual([
      { type: "plan_update", title: "Working on it" },
      { type: "task_update", id: "tc1", title: "Search the archive", status: "in_progress" },
      { type: "task_update", id: "tc1", title: "Search the archive", status: "complete" },
      { type: "markdown_text", text: "Found it." },
    ]);
    expect(calls[1]!.method).toBe("chat.stopStream");
    expect(calls[1]!.body.chunks).toEqual([{ type: "plan_update", title: "Done" }]);
    vi.unstubAllGlobals();
  });

  it("retitles the plan when the turn stops, fails or waits on approval", async () => {
    for (const [outcome, title] of [
      [{ stopped: true, pending: false }, "Stopped"],
      [
        { stopped: false, pending: false, errorText: "Something went wrong answering this." },
        "Something went wrong",
      ],
      [{ stopped: false, pending: true }, "Waiting for approval"],
    ] as const) {
      const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
      const stream = open();
      stream.progress!({
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "lookupBuild",
        input: {},
      });
      stream.text("On it.");
      await stream.end(outcome);
      const closing = calls.find((c) => c.method === "chat.stopStream")!.body.chunks as Array<{
        type: string;
        title?: string;
      }>;
      expect(closing.find((c) => c.type === "plan_update")?.title).toBe(title);
      vi.unstubAllGlobals();
    }
  });

  it("sends no plan when the turn calls no tools", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const stream = open();
    stream.text("Just text.");
    await stream.end({ stopped: false, pending: false });
    expect(JSON.stringify(calls.map((c) => c.body.chunks))).not.toContain("plan_update");
    vi.unstubAllGlobals();
  });

  it("marks a tool call waiting on approval as pending when the turn pauses", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const stream = open({ progress: "tasks" });
    stream.progress!({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "requestApproval",
      input: {},
    });
    stream.text("Checking first.");
    await stream.end({ stopped: false, pending: true });
    expect(calls[1]!.method).toBe("chat.stopStream");
    expect(calls[1]!.body.chunks).toEqual([
      {
        type: "task_update",
        id: "tc1",
        title: "Request approval",
        status: "pending",
        details: "Waiting for approval",
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("with progress off, sends no task cards", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const stream = open({ progress: "off" });
    stream.progress!({ type: "tool-call", toolCallId: "tc1", toolName: "searchDocs", input: {} });
    stream.text("answer");
    await stream.end({ stopped: false, pending: false });
    expect(calls[0]!.body.chunks).toEqual([{ type: "markdown_text", text: "answer" }]);
    vi.unstubAllGlobals();
  });

  it("appends a stream error before stopping", async () => {
    const calls = mockSlack(() => ({ ok: true, ts: "1700000000.5" }));
    const stream = open();
    stream.text("Partial");
    await stream.end({ stopped: false, pending: false, errorText: "model exploded" });
    expect(calls[1]!.method).toBe("chat.stopStream");
    expect(calls[1]!.body.chunks).toEqual([
      { type: "markdown_text", text: "\n\n_model exploded_" },
    ]);
    vi.unstubAllGlobals();
  });

  it("reports nothing delivered when nothing streamed or Slack refuses the stream", async () => {
    const calls = mockSlack(() => ({ ok: false, error: "channel_not_found" }));
    expect(await open().end({ stopped: false, pending: false })).toEqual({ delivered: false });
    expect(calls).toHaveLength(0);

    const refused = open();
    refused.text("hello");
    expect(await refused.end({ stopped: false, pending: false })).toEqual({ delivered: false });
    expect(calls.map((c) => c.method)).toEqual(["chat.startStream"]);
    vi.unstubAllGlobals();
  });

  it("waits out a rate limit and resends the same batch", async () => {
    const calls = mockSlack((_call, index) =>
      index === 0
        ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "retry-after": "0.01" },
          })
        : { ok: true, ts: "1700000000.5" }
    );
    const stream = open();
    stream.text("once");
    await stream.end({ stopped: false, pending: false });
    expect(calls.map((c) => c.method)).toEqual([
      "chat.startStream",
      "chat.startStream",
      "chat.stopStream",
    ]);
    expect(texts(calls[1]!)).toBe("once");
    vi.unstubAllGlobals();
  });

  it("never retries an append with an unknown outcome, and posts the rest as its own message", async () => {
    const calls = mockSlack((call) => {
      if (call.method === "chat.startStream") return { ok: true, ts: "1700000000.5" };
      if (call.method === "chat.appendStream") throw new TypeError("fetch failed");
      return { ok: true, ts: "1700000000.9" };
    });
    const stream = open();
    stream.text("first ");
    await new Promise((r) => setTimeout(r, 350));
    stream.text("second");
    expect(await stream.end({ stopped: false, pending: false })).toEqual({ delivered: true });
    expect(calls.map((c) => c.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.postMessage",
    ]);
    expect(calls[3]!.body).toEqual({
      channel: "C9",
      thread_ts: "1699999999.0000",
      markdown_text: "second",
    });
    vi.unstubAllGlobals();
  });

  it("reports the reply undelivered when posting the rest of it fails too", async () => {
    mockSlack((call) => {
      if (call.method === "chat.startStream") return { ok: true, ts: "1700000000.5" };
      if (call.method === "chat.appendStream") throw new TypeError("fetch failed");
      if (call.method === "chat.postMessage") return { ok: false, error: "channel_not_found" };
      return { ok: true };
    });
    const stream = open();
    stream.text("first ");
    await new Promise((r) => setTimeout(r, 350));
    stream.text("second");
    expect(await stream.end({ stopped: false, pending: false })).toEqual({ delivered: false });
    vi.unstubAllGlobals();
  });

  it("stops waiting out rate limits at the end of the turn and posts the rest instead", async () => {
    const calls = mockSlack((call) => {
      if (call.method === "chat.startStream") return { ok: true, ts: "1700000000.5" };
      if (call.method === "chat.appendStream") {
        return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: { "retry-after": "40" },
        });
      }
      return { ok: true, ts: "1700000000.9" };
    });
    const stream = open();
    stream.text("first ");
    await new Promise((r) => setTimeout(r, 350));
    stream.text("second");
    const started = Date.now();
    expect(await stream.end({ stopped: false, pending: false })).toEqual({ delivered: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls.map((c) => c.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.postMessage",
    ]);
    expect(calls[3]!.body.markdown_text).toBe("second");
    vi.unstubAllGlobals();
  });

  it("drops the rest of the turn once the user stopped the stream in Slack", async () => {
    const calls = mockSlack((call) =>
      call.method === "chat.startStream"
        ? { ok: true, ts: "1700000000.5" }
        : { ok: false, error: "stopped_by_user" }
    );
    const stream = open();
    stream.text("first ");
    await new Promise((r) => setTimeout(r, 350));
    stream.text("second");
    expect(await stream.end({ stopped: true, pending: false })).toEqual({ delivered: true });
    expect(calls.map((c) => c.method)).toEqual(["chat.startStream", "chat.appendStream"]);
    vi.unstubAllGlobals();
  });
});

describe("slack approvals after a stop", () => {
  it("rewrites each controls message without its buttons", async () => {
    const calls = mockSlack();
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-cancel",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await c.cancelInteraction!(
      [
        { toolCallId: "tc1", toolName: "refund", input: { amount: 5 }, ref: "1700000000.7" },
        { toolCallId: "tc2", toolName: "noControls" },
      ],
      {
        handle: { teamId: "T1", channel: "C9", threadTs: "1699999999.0001" },
        bound: true,
      } as never
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("chat.update");
    expect(calls[0]!.body.ts).toBe("1700000000.7");
    const blocks = calls[0]!.body.blocks as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["section", "context"]);
    expect(JSON.stringify(blocks)).toContain("refund");
    expect(JSON.stringify(blocks)).toContain("Stopped");
    vi.unstubAllGlobals();
  });

  it("takes down every controls message even when one update fails", async () => {
    const calls = mockSlack((_call, index) =>
      index === 0 ? { ok: false, error: "message_not_found" } : { ok: true }
    );
    const c = slack({
      startOn: "event.event.type == 'message'",
      endpoint: slackEvents,
      id: "s-cancel-2",
      token: "t",
      apiBaseUrl: "https://mock.slack",
    });
    await expect(
      c.cancelInteraction!(
        [
          { toolCallId: "tc1", toolName: "refund", ref: "1700000000.7" },
          { toolCallId: "tc2", toolName: "refund", ref: "1700000000.8" },
        ],
        { handle: { channel: "C9", threadTs: "1699999999.0001" }, bound: true } as never
      )
    ).rejects.toThrow(/1700000000.7: message_not_found/);
    expect(calls.map((c) => c.body.ts)).toEqual(["1700000000.7", "1700000000.8"]);
    vi.unstubAllGlobals();
  });
});

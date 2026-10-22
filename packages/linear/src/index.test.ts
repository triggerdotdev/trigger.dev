import { afterEach, describe, expect, it, vi } from "vitest";
import { webhooks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import {
  approvalCard,
  defaultLinearInbound,
  inputToMarkdown,
  isStopSignal,
  linear,
  linearControl,
  linearFileParts,
  linearPlanTool,
  LINEAR_PLAN_TOOL_NAME,
  linearSessionHandle,
  seedFromPreviousComments,
  stoppedMarkdown,
  summaryLine,
  type LinearAgentSessionEvent,
  type LinearChannelMessage,
  type LinearRunSurface,
  webhookSource,
} from "./index.js";

const linearEvents = webhooks.endpoint.define({ id: "linear-test", source: webhookSource() });

const createdEvent = (over: Partial<LinearAgentSessionEvent> = {}): LinearAgentSessionEvent => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org_1",
  appUserId: "app_1",
  agentSession: {
    id: "sess_1",
    status: "pending",
    creatorId: "usr_jane",
    creator: { id: "usr_jane", displayName: "Jane" },
    issueId: "iss_1",
    issue: {
      id: "iss_1",
      identifier: "ENG-412",
      title: "Login page throws 500 on SSO callback",
    },
    commentId: "cmt_1",
    sourceCommentId: "cmt_1",
    comment: {
      id: "cmt_1",
      body: "@triage can you find the root cause?",
      userId: "usr_jane",
    },
  },
  promptContext: '<issue identifier="ENG-412"><title>Login page throws 500</title></issue>',
  guidance: [{ body: "Always link the PR." }],
  previousComments: [
    {
      id: "cmt_0",
      body: "Seeing this since yesterday",
      userId: "usr_bob",
      user: { id: "usr_bob", displayName: "Bob" },
    },
    { id: "cmt_x", body: "Earlier reply from the app", userId: "app_1" },
  ],
  ...over,
});

const promptedEvent = (
  body: string,
  over: Partial<NonNullable<LinearAgentSessionEvent["agentActivity"]>> = {}
): LinearAgentSessionEvent => ({
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: "org_1",
  agentSession: { id: "sess_1", status: "active", issueId: "iss_1" },
  agentActivity: {
    id: "act_9",
    content: { type: "prompt", body },
    userId: "usr_jane",
    user: { id: "usr_jane", displayName: "Jane" },
    ...over,
  },
});

type Call = {
  url: string;
  query: string;
  variables: Record<string, any>;
  auth: unknown;
};

function mockGraphql(ids: string[] = ["act_1", "act_2", "act_3"]) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const parsed = JSON.parse(init.body);
      calls.push({
        url,
        query: parsed.query,
        variables: parsed.variables,
        auth: init.headers.authorization,
      });
      const id = ids[n++] ?? `act_${n}`;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            agentActivityCreate: { success: true, agentActivity: { id } },
          },
        }),
      };
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("linear endpoint", () => {
  it("is a Linear source whose signing secret Linear issues, with a setup prompt", () => {
    const source = webhookSource();
    expect(source).toMatchObject({ provider: "linear", secretProvisioning: "provider" });
    expect(source.setupPrompt).toContain("Agent session events");
    expect(linearEvents).toEqual({ id: "linear-test", source: "linear" });
  });

  it("refuses a connector without an endpoint, or on a non-Linear endpoint", () => {
    expect(() => linear({ id: "l-none", token: "t" } as never)).toThrow(
      'linear("l-none"): an endpoint is required'
    );
    const github = webhooks.endpoint.define({
      id: "linear-test-github",
      source: webhooks.github(),
    });
    expect(() => linear({ endpoint: github as never, id: "l-wrong", token: "t" })).toThrow(
      'endpoint "linear-test-github" has source "github"'
    );
  });

  it("subscribes the connector to the endpoint", () => {
    const c = linear({ endpoint: linearEvents, id: "l-sub", token: "t" });
    expect(c.endpointId).toBe("linear-test");
    expect(c.source).toBe("linear");
    expect(c.errorMessage).toBeUndefined();
    expect(
      linear({ endpoint: linearEvents, id: "l-err", token: "t", errorMessage: "Couldn't do that." })
        .errorMessage
    ).toBe("Couldn't do that.");
    const errorLine = ({ runId }: { runId?: string }) => `Couldn't do that (ref ${runId}).`;
    expect(
      linear({ endpoint: linearEvents, id: "l-err-fn", token: "t", errorMessage: errorLine })
        .errorMessage
    ).toBe(errorLine);
  });
});

describe("linear channel: inbound", () => {
  it("frames a mention with the issue context, guidance and the comment", () => {
    const inbound = defaultLinearInbound(createdEvent()) as {
      message: string;
      externalUserId?: string;
      externalMessageId?: string;
    };
    expect(inbound.message).toContain(
      'Jane mentioned you on ENG-412 "Login page throws 500 on SSO callback".'
    );
    expect(inbound.message).toContain("Workspace guidance:\nAlways link the PR.");
    expect(inbound.message).toContain('Issue context:\n<issue identifier="ENG-412">');
    expect(inbound.message).toContain("Jane's comment:\n@triage can you find the root cause?");
    expect(inbound.externalUserId).toBe("usr_jane");
    expect(inbound.externalMessageId).toBe("cmt_1");
  });

  it("frames a delegation (no comment) as an assignment", () => {
    const inbound = defaultLinearInbound(
      createdEvent({
        agentSession: {
          id: "sess_2",
          creatorId: "usr_jane",
          issueId: "iss_1",
          issue: { id: "iss_1", identifier: "ENG-412" },
          commentId: "cmt_placeholder",
          sourceCommentId: null,
          comment: {
            id: "cmt_placeholder",
            body: "This thread is for an agent session with triage.",
          },
        },
      })
    ) as { message: string; externalMessageId?: string };
    expect(inbound.message.startsWith("usr_jane assigned ENG-412 to you.")).toBe(true);
    expect(inbound.message).not.toContain("comment:");
    expect(inbound.message).not.toContain("This thread is for");
    expect(inbound.externalMessageId).toBe("cmt_placeholder");
  });

  it("honors the context switches", () => {
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      context: { guidance: false, promptContext: false },
    });
    const inbound = c.inbound(createdEvent()) as { message: string };
    expect(inbound.message).not.toContain("Workspace guidance");
    expect(inbound.message).not.toContain("Issue context");
    expect(inbound.message).toContain("Jane's comment");
  });

  it("maps a prompt to its body, attributed to the user and activity", () => {
    const inbound = defaultLinearInbound(promptedEvent("also check the staging logs")) as {
      message: string;
      externalUserId?: string;
      externalMessageId?: string;
    };
    expect(inbound).toEqual({
      message: "also check the staging logs",
      externalUserId: "usr_jane",
      externalMessageId: "act_9",
    });
  });

  it("turns a stop signal into a wind-down instruction, and into a stop control mid-turn", () => {
    const e = promptedEvent("", { signal: "stop" });
    expect(isStopSignal(e)).toBe(true);
    expect(linearControl(e)).toEqual({ kind: "stop", message: "stopped from Linear" });
    expect(linearControl(promptedEvent("carry on"))).toBeNull();
    expect(
      linearControl(promptedEvent("", { signal: "stop", createdAt: "2026-10-01T10:00:00.000Z" }))
    ).toEqual({
      kind: "stop",
      message: "stopped from Linear",
      at: Date.parse("2026-10-01T10:00:00.000Z"),
    });
    expect(linear({ endpoint: linearEvents, id: "l", token: "t" }).onControl!(e)).toEqual({
      kind: "stop",
      message: "stopped from Linear",
    });
    const inbound = defaultLinearInbound(e) as { message: string };
    expect(inbound.message).toMatch(/asked you to stop/);
  });
});

describe("linear channel: seed, bind, routing", () => {
  it("seeds prior comments, attributing the app's own comments as assistant", () => {
    expect(seedFromPreviousComments(createdEvent())).toEqual([
      {
        role: "user",
        text: "Bob: Seeing this since yesterday",
        externalMessageId: "cmt_0",
        externalUserId: "usr_bob",
      },
      {
        role: "assistant",
        text: "Earlier reply from the app",
        externalMessageId: "cmt_x",
        externalUserId: "app_1",
      },
    ]);
    expect(seedFromPreviousComments(promptedEvent("x"))).toEqual([]);
  });

  it("does not seed when previousComments context is off", () => {
    expect(
      linear({ endpoint: linearEvents, id: "l", token: "t", context: { previousComments: false } })
        .seed
    ).toBeUndefined();
    expect(linear({ endpoint: linearEvents, id: "l", token: "t" }).seed).toBeDefined();
  });

  it("binds a session to the agent session, carrying org and issue", () => {
    expect(linearSessionHandle(createdEvent())).toEqual({
      agentSessionId: "sess_1",
      organizationId: "org_1",
      issueId: "iss_1",
      issueIdentifier: "ENG-412",
    });
    expect(
      linearSessionHandle({
        type: "AgentSessionEvent",
        action: "created",
      } as any)
    ).toBeNull();
  });

  it("keys one session per agent session and guards on the event type", () => {
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    expect(c.key).toBe("{body.agentSession.id}");
    expect(c.filter).toBe("event.type == 'AgentSessionEvent'");
    const withUser = linear({
      endpoint: linearEvents,
      id: "l2",
      token: "t",
      filter: "event.organizationId == 'org_1'",
    });
    expect(withUser.filter).toBe(
      "event.type == 'AgentSessionEvent' && (event.organizationId == 'org_1')"
    );
    expect(c.source).toBe("linear");
  });
});

describe("linear channel: egress", () => {
  it("ack posts an ephemeral thought and the response posts a response activity", async () => {
    const calls = mockGraphql(["act_ack", "act_resp"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "lin_oauth_x",
      apiUrl: "https://mock.linear/graphql",
    });
    const ev = createdEvent();

    const ackMsg = c.ack!(ev, { recovered: false })!;
    const ackRes = await c.send!(ackMsg, {
      event: ev,
      deliveryId: "d1",
      mode: "final",
      final: false,
      bound: false,
    });
    expect(ackRes.ref).toBe("act_ack");
    expect(calls[0]!.url).toBe("https://mock.linear/graphql");
    expect(calls[0]!.auth).toBe("Bearer lin_oauth_x");
    expect(calls[0]!.variables.input).toEqual({
      id: expect.stringMatching(UUID_RE),
      agentSessionId: "sess_1",
      content: { type: "thought", body: "Looking into this..." },
      ephemeral: true,
    });

    const out = c.outbound!({
      text: "Root cause: expired SSO cert.  ",
      message: {} as any,
      final: true,
      stopped: false,
    })!;
    const res = await c.send!(out, {
      event: ev,
      deliveryId: "d1",
      mode: "final",
      final: true,
      bound: false,
      previousRef: "act_ack",
    });
    expect(res.ref).toBe("act_resp");
    expect(calls[1]!.variables.input).toEqual({
      id: expect.stringMatching(UUID_RE),
      agentSessionId: "sess_1",
      content: { type: "response", body: "Root cause: expired SSO cert." },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.input.id).not.toBe(calls[1]!.variables.input.id);

    const withSummary = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
      summarize: true,
    });
    const summarized = withSummary.outbound!({
      text: "Root cause: expired SSO cert.",
      message: {} as any,
      final: true,
      stopped: false,
    }) as LinearChannelMessage;
    expect(summarized.summary).toBe("Root cause: expired SSO cert.");
  });

  it("a stopped reply closes an open code fence and is marked as stopped", () => {
    expect(stoppedMarkdown("Intro\n\n```ts\nconst a = 1;")).toBe(
      "Intro\n\n```ts\nconst a = 1;\n```\n\n_Stopped._"
    );
    expect(stoppedMarkdown("Done.\n\n```ts\nx\n```\n")).toBe(
      "Done.\n\n```ts\nx\n```\n\n_Stopped._"
    );
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    const out = c.outbound!({
      text: "partial",
      message: {} as any,
      final: true,
      stopped: true,
    }) as LinearChannelMessage;
    expect(out.activity).toEqual({ type: "response" });
    expect(out.text).toBe("partial\n\n_Stopped._");
  });

  it("summaryLine takes the first non-empty line, strips markdown and caps at 255", () => {
    expect(summaryLine("\n\n## **Root cause**: expired cert\nmore")).toBe(
      "Root cause: expired cert"
    );
    expect(summaryLine("   ")).toBeUndefined();
    expect(summaryLine(`\t${String.fromCharCode(0)} \n`)).toBeUndefined();
    expect(summaryLine(`Fixed${String.fromCharCode(0)}\tthe\u0007cert`)).toBe("Fixed the cert");
    expect(summaryLine("x".repeat(300))!.length).toBe(255);
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    expect(
      (
        c.outbound!({
          text: "hello",
          message: {} as any,
          final: true,
          stopped: false,
        }) as LinearChannelMessage
      ).summary
    ).toBeUndefined();
  });

  it("maps an error reply to an error activity and a non-final update to an ephemeral thought", () => {
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    expect(
      (
        c.outbound!({
          text: "",
          message: {} as any,
          final: true,
          stopped: false,
          error: new Error("x"),
        }) as LinearChannelMessage
      ).activity
    ).toEqual({ type: "error" });
    expect(
      (
        c.outbound!({
          text: "partial",
          message: {} as any,
          final: false,
          stopped: false,
        }) as LinearChannelMessage
      ).activity
    ).toEqual({ type: "thought", ephemeral: true });
    expect(
      c.outbound!({
        text: "",
        message: {} as any,
        final: true,
        stopped: false,
      })
    ).toBeNull();
    const pending = c.outbound!({
      text: "Here is what I found so far.",
      message: {} as any,
      final: true,
      stopped: false,
      pending: true,
    }) as LinearChannelMessage;
    expect(pending.activity).toEqual({ type: "thought" });
    expect(pending.summary).toBeUndefined();
  });

  it("a bound turn posts into the handle's session, resolving the token from the organization", async () => {
    const calls = mockGraphql(["act_b"]);
    const seen: unknown[] = [];
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: async (event) => {
        seen.push((event as { organizationId?: string }).organizationId);
        return "tok_from_org";
      },
      apiUrl: "https://mock.linear/graphql",
    });
    const res = await c.send!(
      { text: "Sentry reported a new occurrence." },
      {
        handle: { agentSessionId: "sess_7", organizationId: "org_9" },
        mode: "final",
        final: true,
        bound: true,
      }
    );
    expect(res.ref).toBe("act_b");
    expect(seen).toEqual(["org_9"]);
    expect(calls[0]!.auth).toBe("Bearer tok_from_org");
    expect(calls[0]!.variables.input.agentSessionId).toBe("sess_7");
    expect(calls[0]!.variables.input.content).toEqual({
      type: "response",
      body: "Sentry reported a new occurrence.",
    });

    await expect(
      c.send!({ text: "nowhere" }, { mode: "final", final: true, bound: true })
    ).rejects.toThrow(/no agent session to post into/);
  });

  it("surfaces GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          errors: [{ message: "Entity not found: AgentSession" }],
        }),
      }))
    );
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    await expect(
      c.send!(
        { text: "hi" },
        {
          event: createdEvent(),
          deliveryId: "d",
          mode: "final",
          final: true,
          bound: false,
        }
      )
    ).rejects.toThrow(/Entity not found/);
  });
});

describe("linear channel: human in the loop", () => {
  it("renders one select elicitation per pending tool call, with readable option values", async () => {
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    const msg = c.renderInteraction!(
      [
        {
          toolCallId: "call-a",
          toolName: "createSubIssues",
          input: { count: 3 },
        },
        { toolCallId: "call-b", toolName: "closeIssue" },
      ],
      { event: createdEvent(), deliveryId: "d" }
    ) as LinearChannelMessage;
    expect(msg.activities).toHaveLength(2);
    expect(msg.activities![0]!.signalMetadata).toEqual({
      options: [
        { label: "Approve", value: "Approve createSubIssues [call-a]" },
        { label: "Deny", value: "Deny createSubIssues [call-a]" },
      ],
    });
    expect(msg.activities![0]!.text).toContain("**Count:** 3");
    expect(msg.activities![1]!.text).toBe("**Approval needed:** `closeIssue`");

    const calls = mockGraphql(["act_e1", "act_e2"]);
    const res = await c.send!(msg, {
      event: createdEvent(),
      deliveryId: "d",
      mode: "final",
      final: false,
      bound: false,
    });
    expect(res.ref).toBe("act_e2");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.input.signal).toBe("select");
    expect(calls[0]!.variables.input.content.type).toBe("elicitation");
    expect(calls[0]!.variables.input.ephemeral).toBeUndefined();
  });

  it("names the call in every option value, so a card always resolves its own call even across turns", () => {
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    const msg = c.renderInteraction!(
      [
        { toolCallId: "call-a", toolName: "createSubIssues", input: { issues: ["One"] } },
        { toolCallId: "call-b", toolName: "createSubIssues", input: { issues: ["Two"] } },
        { toolCallId: "call-c", toolName: "closeIssue" },
      ],
      { event: createdEvent(), deliveryId: "d" }
    ) as LinearChannelMessage;
    expect(msg.activities!.map((a) => a.signalMetadata!.options)).toEqual([
      [
        { label: "Approve", value: "Approve createSubIssues [call-a]" },
        { label: "Deny", value: "Deny createSubIssues [call-a]" },
      ],
      [
        { label: "Approve", value: "Approve createSubIssues [call-b]" },
        { label: "Deny", value: "Deny createSubIssues [call-b]" },
      ],
      [
        { label: "Approve", value: "Approve closeIssue [call-c]" },
        { label: "Deny", value: "Deny closeIssue [call-c]" },
      ],
    ]);
    expect(c.onInteraction!(promptedEvent("Approve createSubIssues [call-a]"))).toEqual({
      toolName: "createSubIssues",
      toolCallId: "call-a",
      output: { approved: true },
    });
    expect(c.onInteraction!(promptedEvent("Deny createSubIssues [call-b]"))).toEqual({
      toolName: "createSubIssues",
      toolCallId: "call-b",
      output: { approved: false },
    });
  });

  it("renders a list of proposed items as a numbered markdown list, not JSON", () => {
    const body = inputToMarkdown({
      issues: [
        {
          title: "Implement dual-secret verification",
          description: "Accept both secrets during overlap.",
        },
        {
          title: "Add rotation state",
          description: "Track current and previous secret.",
          priority: 2,
        },
      ],
    });
    expect(body).toBe(
      [
        "Issues",
        "",
        "1. **Implement dual-secret verification**",
        "   Accept both secrets during overlap.",
        "2. **Add rotation state**",
        "   - Description: Track current and previous secret.",
        "   - Priority: 2",
      ].join("\n")
    );
    expect(inputToMarkdown({ orderId: "o-1", amount: 50, refund: true })).toBe(
      "- **Order id:** o-1\n- **Amount:** 50\n- **Refund:** true"
    );
    expect(inputToMarkdown(["a", "b"])).toBe("- a\n- b");
    expect(inputToMarkdown([[1, 2]])).toContain("```json");
    expect(approvalCard({ toolCallId: "c", toolName: "closeIssue" })).toBe(
      "**Approval needed:** `closeIssue`"
    );
  });

  it("uses a per-tool approvals renderer when one is configured", () => {
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      approvals: {
        createSubIssues: (input) => ({
          title: "Create these sub-issues?",
          body: (input as { issues: Array<{ title: string }> }).issues
            .map((i) => `- ${i.title}`)
            .join("\n"),
        }),
      },
    });
    const msg = c.renderInteraction!(
      [
        {
          toolCallId: "call-a",
          toolName: "createSubIssues",
          input: { issues: [{ title: "One" }] },
        },
      ],
      { event: createdEvent(), deliveryId: "d" }
    ) as LinearChannelMessage;
    expect(msg.activities![0]!.text).toBe("**Create these sub-issues?**\n\n- One");
    expect(msg.activities![0]!.signalMetadata).toEqual({
      options: [
        { label: "Approve", value: "Approve createSubIssues [call-a]" },
        { label: "Deny", value: "Deny createSubIssues [call-a]" },
      ],
    });
  });

  it("truncates an oversized tool input in the elicitation body", () => {
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    const msg = c.renderInteraction!(
      [
        {
          toolCallId: "big",
          toolName: "x",
          input: { blob: "y".repeat(10_000) },
        },
      ],
      { event: createdEvent(), deliveryId: "d" }
    ) as LinearChannelMessage;
    expect(msg.activities![0]!.text).toContain("... (truncated)");
    expect(msg.activities![0]!.text.length).toBeLessThan(3000);
  });

  it("resolves a selected option to the tool decision, and leaves free text and stop alone", () => {
    const c = linear({ endpoint: linearEvents, id: "l", token: "t" });
    expect(c.onInteraction!(promptedEvent("Approve createSubIssues"))).toEqual({
      toolName: "createSubIssues",
      output: { approved: true },
    });
    expect(c.onInteraction!(promptedEvent("  Deny createSubIssues \n"))).toEqual({
      toolName: "createSubIssues",
      output: { approved: false },
    });
    expect(c.onInteraction!(promptedEvent("go ahead, but only two of them"))).toBeNull();
    expect(
      c.onInteraction!(promptedEvent("Approve createSubIssues", { signal: "stop" }))
    ).toBeNull();
    expect(c.onInteraction!(createdEvent())).toBeNull();
  });

  it("finalizeInteraction records the decision as a thought on the session", async () => {
    const calls = mockGraphql(["act_f"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    await c.finalizeInteraction!(promptedEvent("Approve createSubIssues"), {
      toolCallId: "call-a",
      output: { approved: true },
    });
    expect(calls[0]!.variables.input).toEqual({
      agentSessionId: "sess_1",
      content: { type: "thought", body: "Approved by Jane." },
    });
  });
});

describe("linear channel: progress and surface", () => {
  const turnCtx = (over: Record<string, unknown> = {}) =>
    ({ event: createdEvent(), deliveryId: "d1", bound: false, ...over }) as any;

  it("mirrors a tool call as an ephemeral action, then the result as the same action with result", async () => {
    const calls = mockGraphql(["act_p1", "act_p2", "act_p3"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    await c.progress!(
      { type: "tool-call", toolCallId: "tc1", toolName: "searchDocs", input: { q: "sso" } },
      turnCtx()
    );
    await c.progress!(
      { type: "tool-result", toolCallId: "tc1", toolName: "searchDocs", output: { hits: 3 } },
      turnCtx()
    );
    await c.progress!(
      { type: "tool-error", toolCallId: "tc2", toolName: "fetchLogs", errorText: "timeout" },
      turnCtx()
    );
    expect(calls.map((k) => k.variables.input)).toEqual([
      {
        id: expect.stringMatching(UUID_RE),
        agentSessionId: "sess_1",
        content: { type: "action", action: "searchDocs", parameter: '{\n  "q": "sso"\n}' },
        ephemeral: true,
      },
      {
        id: expect.stringMatching(UUID_RE),
        agentSessionId: "sess_1",
        content: {
          type: "action",
          action: "searchDocs",
          parameter: "",
          result: '{\n  "hits": 3\n}',
        },
      },
      {
        id: expect.stringMatching(UUID_RE),
        agentSessionId: "sess_1",
        content: { type: "action", action: "fetchLogs", parameter: "", result: "Error: timeout" },
      },
    ]);
    expect(new Set(calls.map((k) => k.variables.input.id)).size).toBe(3);
  });

  it("derives a stable idempotency id per activity, so a retried turn reposts the same activity", async () => {
    const calls = mockGraphql(["a1", "a2", "a3", "a4"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    const ev = createdEvent();
    const out = c.outbound!({ text: "Done.", message: {} as any, final: true, stopped: false })!;
    const sendCtx = {
      event: ev,
      deliveryId: "d1",
      mode: "final" as const,
      final: true,
      bound: false,
    };
    await c.send!(out, sendCtx);
    await c.send!(out, sendCtx);
    expect(calls[0]!.variables.input.id).toBe(calls[1]!.variables.input.id);

    await c.progress!(
      { type: "tool-call", toolCallId: "tc1", toolName: "searchDocs", input: {} },
      turnCtx()
    );
    await c.progress!(
      { type: "tool-call", toolCallId: "tc1", toolName: "searchDocs", input: {} },
      turnCtx()
    );
    expect(calls[2]!.variables.input.id).toBe(calls[3]!.variables.input.id);
    expect(calls[2]!.variables.input.id).not.toBe(calls[0]!.variables.input.id);
  });

  it("progress can be turned off, and posts into the bound session on a bound turn", async () => {
    expect(
      linear({ endpoint: linearEvents, id: "l", token: "t", progress: "off" }).progress
    ).toBeUndefined();
    const calls = mockGraphql(["act_b1"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    await c.progress!(
      { type: "tool-call", toolCallId: "tc", toolName: "lookup", input: "o-1" },
      turnCtx({
        event: undefined,
        deliveryId: undefined,
        bound: true,
        handle: { agentSessionId: "sess_9" },
      })
    );
    expect(calls[0]!.variables.input.agentSessionId).toBe("sess_9");
    expect(calls[0]!.variables.input.content.parameter).toBe("o-1");
  });

  it("surface exposes plan, thought, action, link, summary and the session handle", async () => {
    const calls = mockGraphql(["a1", "a2", "a3", "a4", "a5"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    const surface = c.surface!(turnCtx()) as unknown as Omit<LinearRunSurface, "react" | "unreact">;
    expect(surface.session).toEqual({
      agentSessionId: "sess_1",
      organizationId: "org_1",
      issueId: "iss_1",
      issueIdentifier: "ENG-412",
    });
    await surface.plan([
      { content: "Understand", status: "completed" },
      { content: "Fix", status: "inProgress" },
    ]);
    await surface.thought("Checking the SSO config", { ephemeral: true });
    await surface.action("Reading", "auth/sso.ts", "120 lines");
    await surface.link("Pull request", "https://github.com/acme/app/pull/7");
    await surface.summary("## Fixed the **cert** rotation\ndetails");
    expect(calls[0]!.variables).toEqual({
      id: "sess_1",
      input: {
        plan: [
          { content: "Understand", status: "completed" },
          { content: "Fix", status: "inProgress" },
        ],
      },
    });
    expect(calls[1]!.variables.input).toEqual({
      agentSessionId: "sess_1",
      content: { type: "thought", body: "Checking the SSO config" },
      ephemeral: true,
    });
    expect(calls[2]!.variables.input.content).toEqual({
      type: "action",
      action: "Reading",
      parameter: "auth/sso.ts",
      result: "120 lines",
    });
    expect(calls[3]!.variables.input).toEqual({
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/app/pull/7" }],
    });
    expect(calls[4]!.variables.input).toEqual({ summary: "Fixed the cert rotation" });
  });
});

describe("linear plan tool", () => {
  it("replaces the session plan through the current turn's surface, and reports when there is none", async () => {
    const planned: unknown[] = [];
    const spy = vi
      .spyOn(chat, "surface")
      .mockReturnValue({ plan: async (steps: unknown) => void planned.push(steps) } as never);
    const t = linearPlanTool();
    const steps = [
      { content: "Understand the issue", status: "completed" as const },
      { content: "Propose sub-issues", status: "inProgress" as const },
    ];
    const out = await (t.execute as (input: unknown, opts: unknown) => Promise<unknown>)(
      { steps },
      { toolCallId: "tc", messages: [] }
    );
    expect(out).toEqual({ updated: true, steps: 2 });
    expect(planned).toEqual([steps]);

    spy.mockReturnValue(undefined as never);
    const none = await (t.execute as (input: unknown, opts: unknown) => Promise<unknown>)(
      { steps },
      { toolCallId: "tc2", messages: [] }
    );
    expect(none).toEqual({ updated: false, reason: "not a Linear session" });
    spy.mockRestore();
  });

  it("progress does not mirror the plan tool as an action", async () => {
    const calls = mockGraphql(["a1"]);
    const c = linear({
      endpoint: linearEvents,
      id: "l",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
    });
    await c.progress!(
      {
        type: "tool-call",
        toolCallId: "tc",
        toolName: LINEAR_PLAN_TOOL_NAME,
        input: { steps: [] },
      },
      { event: createdEvent(), deliveryId: "d1", bound: false } as never
    );
    expect(calls).toHaveLength(0);
  });
});

describe("linear channel: files, steering and tool choices", () => {
  const upload = (id: string) => `https://uploads.linear.app/org_1/${id}/${id}`;

  it("linearFileParts picks images and PDFs on Linear's upload host out of markdown", () => {
    const md = [
      `Here is the error ![screenshot](${upload("a")}) and the log [trace.pdf](${upload("b")}).`,
      `Same image again ![dup](${upload("a")}), a doc [notes.txt](${upload("c")}),`,
      "and an outside image ![x](https://example.com/x.png).",
    ].join("\n");
    expect(linearFileParts(md)).toEqual([
      { type: "file", mediaType: "image/*", url: upload("a"), filename: "screenshot" },
      { type: "file", mediaType: "application/pdf", url: upload("b"), filename: "trace.pdf" },
    ]);
    expect(linearFileParts(undefined)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `![i${i}](${upload(`u${i}`)})`).join(" ");
    expect(linearFileParts(many)).toHaveLength(10);
  });

  it("linearFileParts reads Linear's <linear-image> tags, dropping the URL's signature", () => {
    const tag = (src: string, alt: string) =>
      `<linear-image quality="preview">${JSON.stringify({ type: "image", attrs: { src, alt } })}</linear-image>`;
    const context = [
      "<issue><description>",
      "Screenshot below.",
      tag(`${upload("a")}?signature=eyJ.abc.def`, "sso-error.png"),
      `and ![second](${upload("b")})`,
      tag("https://example.com/x.png", "outside"),
      "</description></issue>",
    ].join("\n");
    expect(linearFileParts(context)).toEqual([
      { type: "file", mediaType: "image/*", url: upload("a"), filename: "sso-error.png" },
      { type: "file", mediaType: "image/*", url: upload("b"), filename: "second" },
    ]);
  });

  it("linearFileParts skips plain-http upload links and markdown inside a tag's alt text", () => {
    const tag = (src: string, alt: string) =>
      `<linear-image>${JSON.stringify({ type: "image", attrs: { src, alt } })}</linear-image>`;
    const md = [
      tag(upload("a"), `see ![other](${upload("b")})`),
      `![plain](${upload("c").replace("https:", "http:")})`,
    ].join("\n");
    expect(linearFileParts(md)).toEqual([
      {
        type: "file",
        mediaType: "image/*",
        url: upload("a"),
        filename: `see ![other](${upload("b")})`,
      },
    ]);
  });

  it("the default inbound adds files from a prompt, and from the mention and issue context", () => {
    const prompted = defaultLinearInbound(promptedEvent(`what is this? ![shot](${upload("p")})`));
    expect(prompted).toMatchObject({
      message: {
        role: "user",
        parts: [
          { type: "text", text: `what is this? ![shot](${upload("p")})` },
          { type: "file", mediaType: "image/*", url: upload("p"), filename: "shot" },
        ],
      },
      externalMessageId: "act_9",
    });
    const created = defaultLinearInbound(
      createdEvent({
        promptContext: `<issue><description>Broken ![err](${upload("d")})</description></issue>`,
      })
    ) as { message: { parts: Array<{ type: string; url?: string }> } };
    expect(created.message.parts.filter((p) => p.type === "file").map((p) => p.url)).toEqual([
      upload("d"),
    ]);
    expect(defaultLinearInbound(promptedEvent("no files here")).message).toBe("no files here");
  });

  it("download fetches a Linear upload with the app's token for the session's workspace", async () => {
    const requests: Array<{ url: string; auth: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: { headers: Record<string, string> }) => {
        requests.push({ url: String(url), auth: init.headers.authorization });
        return new Response(new Uint8Array([7, 8]), { headers: { "content-type": "image/png" } });
      })
    );
    const orgs: unknown[] = [];
    const c = linear({
      endpoint: linearEvents,
      id: "l-files",
      token: async (event) => {
        orgs.push((event as LinearAgentSessionEvent).organizationId);
        return "lin_oauth";
      },
    });
    const handle = { agentSessionId: "sess_1", organizationId: "org_9" };
    expect(await c.download!(new URL(upload("a")), { handle })).toEqual({
      data: new Uint8Array([7, 8]),
      mediaType: "image/png",
    });
    expect(requests).toEqual([{ url: upload("a"), auth: "Bearer lin_oauth" }]);
    expect(orgs).toEqual(["org_9"]);
    expect(await c.download!(new URL("https://example.com/a.png"), { handle })).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 }))
    );
    await expect(c.download!(new URL(upload("a")), { handle })).rejects.toThrow(/401/);
  });

  it("acknowledges a prompt received mid-work with a thought, which can be reworded or turned off", async () => {
    const calls = mockGraphql(["act_s", "act_t", "act_u"]);
    const ctx = { event: promptedEvent("also check the logs"), deliveryId: "d7", bound: false };
    const apiUrl = "https://mock.linear/graphql";
    await linear({ endpoint: linearEvents, id: "l-recv", token: "t", apiUrl }).received!(
      ctx as never
    );
    expect(calls[0]!.variables.input).toMatchObject({
      agentSessionId: "sess_1",
      content: { type: "thought", body: "Got it, I'll take that into account." },
    });
    expect(calls[0]!.variables.input.id).toMatch(UUID_RE);

    await linear({
      endpoint: linearEvents,
      id: "l-recv2",
      token: "t",
      apiUrl,
      receivedThought: "Noted.",
    }).received!(ctx as never);
    await linear({
      endpoint: linearEvents,
      id: "l-recv3",
      token: "t",
      apiUrl,
      receivedThought: (event) =>
        `Noted: "${(event as LinearAgentSessionEvent).agentActivity?.content?.body}"`,
    }).received!(ctx as never);
    expect(calls.slice(1).map((c) => c.variables.input.content.body)).toEqual([
      "Noted.",
      'Noted: "also check the logs"',
    ]);
    expect(
      linear({ endpoint: linearEvents, id: "l-recv4", token: "t", receivedThought: null }).received
    ).toBeUndefined();
  });

  it("renders a tool's own choices as a select, and resolves the chosen option", async () => {
    const c = linear({
      endpoint: linearEvents,
      id: "l-choice",
      token: "t",
      apiUrl: "https://mock.linear/graphql",
      interactions: {
        pickPlan: (call) => ({
          title: "Which plan?",
          body: `For ${(call.input as { customer: string }).customer}`,
          options: ["Pro", "Team plan"],
        }),
      },
    });
    const msg = c.renderInteraction!(
      [
        { toolCallId: "call_p", toolName: "pickPlan", input: { customer: "Acme" } },
        { toolCallId: "call_r", toolName: "refund", input: { amount: 5 } },
      ],
      { event: createdEvent(), deliveryId: "d1" }
    ) as LinearChannelMessage;
    const [choice, approval] = msg.activities!;
    expect(choice).toMatchObject({
      type: "elicitation",
      text: "**Which plan?**\n\nFor Acme",
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Pro", value: "Pro [choice:call_p]" },
          { label: "Team plan", value: "Team plan [choice:call_p]" },
        ],
      },
    });
    expect((approval as any).signalMetadata.options[0].label).toBe("Approve");

    expect(c.onInteraction!(promptedEvent("Team plan [choice:call_p]"))).toEqual({
      toolCallId: "call_p",
      output: { selected: "Team plan" },
    });
    expect(c.onInteraction!(promptedEvent("see the docs [link]"))).toBeNull();
    expect(c.onInteraction!(promptedEvent("C\\+\\+ [choice:call_p]"))).toEqual({
      toolCallId: "call_p",
      output: { selected: "C\\+\\+" },
    });
    expect(c.onInteraction!(promptedEvent("Team plan \\[choice:call\\_p\\]"))).toEqual({
      toolCallId: "call_p",
      output: { selected: "Team plan" },
    });
    expect(c.onInteraction!(promptedEvent("Approve refund \\[call\\_r\\]"))).toEqual({
      toolName: "refund",
      toolCallId: "call_r",
      output: { approved: true },
    });

    const calls = mockGraphql(["act_f"]);
    await c.finalizeInteraction!(promptedEvent("Team plan [choice:call_p]"), {
      toolCallId: "call_p",
      output: { selected: "Team plan" },
    });
    expect(calls[0]!.variables.input.content).toEqual({
      type: "thought",
      body: 'Jane chose "Team plan".',
    });
  });

  it("posts a note in place of options a renderer fails to build", () => {
    const c = linear({
      endpoint: linearEvents,
      id: "l-choice-err",
      token: "t",
      interactions: {
        broken: () => {
          throw new Error("boom");
        },
      },
    });
    const msg = c.renderInteraction!([{ toolCallId: "call_b", toolName: "broken", input: {} }], {
      event: createdEvent(),
      deliveryId: "d1",
    }) as LinearChannelMessage;
    expect(msg.activities![0]).toMatchObject({
      type: "elicitation",
      text: "`broken` is waiting for an answer, but its options could not be shown.",
    });
    expect((msg.activities![0] as any).signal).toBeUndefined();
  });
});

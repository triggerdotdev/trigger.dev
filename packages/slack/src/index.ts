import { chat } from "@trigger.dev/sdk/ai";
import type {
  ChannelAckCtx,
  ChannelConnector,
  ChannelInteractionCtx,
  ChannelInteractionResolution,
  ChannelMessage,
  ChannelMessageInput,
  ChannelPendingToolCall,
  ChannelReaction,
  ChannelReactCtx,
  ChannelReactions,
  ChannelReply,
  ChannelSendCtx,
} from "@trigger.dev/sdk/ai";
import type {
  WebhookHandshakeConfig,
  WebhookHmacConfig,
  WebhookSource,
} from "@trigger.dev/core/v3";

// A minimal Slack Events API envelope; pass your own event type for fuller typing.
export type SlackMessageEvent = {
  type: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type: string;
    subtype?: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
};

// Slack signs `X-Slack-Signature: v0=<hex>` over `v0:{timestamp}:{body}`; the timestamp rides in
// `X-Slack-Request-Timestamp`. You paste the Slack signing secret as the endpoint's signing secret.
const SLACK_VERIFIER: WebhookHmacConfig = {
  scheme: "hmac",
  algorithm: "sha256",
  encoding: "hex",
  signatureHeader: "x-slack-signature",
  signature: { fieldSeparator: "=", field: "v0" },
  timestamp: {
    source: { from: "header", name: "x-slack-request-timestamp" },
    toleranceSeconds: 300,
  },
  signingString: { template: "v0:{timestamp}:{body}" },
  idempotencyField: { from: "body", name: "event_id" },
  formPayload: { field: "payload" },
};

// Slack's Event Subscriptions url_verification handshake: echo the challenge, do not record/route.
const SLACK_HANDSHAKE: WebhookHandshakeConfig = {
  matchPath: "type",
  matchValue: "url_verification",
  respondPath: "challenge",
};

/**
 * One session per Slack thread, for BOTH message events and block_actions interactivity (a button click
 * on the in-thread ack). thread_ts is only on replies, so a thread-STARTING message falls back to ts;
 * interactivity carries the same thread via `container.thread_ts` / `container.message_ts`. The `||`
 * operator resolves to the first non-empty path, so both surfaces converge on one externalId.
 */
const DEFAULT_KEY =
  "{body.team_id || body.team.id}:{body.event.channel || body.container.channel_id}:{body.event.thread_ts || body.event.ts || body.container.thread_ts || body.container.message_ts}";

/**
 * Mandatory loop guard for MESSAGE events: `bot_id == null` drops the agent's own posts (no reply loop);
 * the subtype allowlist keeps real user messages (absent subtype matches `null`) and drops system/edit
 * events. Interactivity (block_actions) is a separate surface, admitted via INTERACTIVITY_PASS.
 */
const SELF_MESSAGE_GUARD =
  "event.event.type == 'message' && event.event.bot_id == null && event.event.subtype in [null,'file_share','thread_broadcast']";

/** Interactivity callbacks (button clicks) always pass the loop guard; onInteraction resolves them. */
const INTERACTIVITY_PASS = "event.type == 'block_actions'";

const SLACK_API_BASE_URL = "https://slack.com/api";

export type SlackToken<TEvent> = string | ((event: TEvent) => string | Promise<string>);

export type SlackChannelOptions<TEvent> = {
  id: string;
  /** Bot token (xoxb-...). A string for one workspace, or a resolver keyed on the event's team_id. */
  token: SlackToken<TEvent>;
  /** Session key template. Defaults to one session per thread. */
  key?: string;
  /** Map a Slack event to the turn's message. Defaults to the message text with the bot mention stripped. */
  inbound?: (event: TEvent) => ChannelMessageInput;
  /** Map the agent's reply to a Slack message. Defaults to the reply text (null posts nothing). */
  outbound?: (reply: ChannelReply) => ChannelMessage | null;
  /** Placeholder posted while the agent works, then edited to the answer. `null` posts only the answer. */
  ack?: ((event: TEvent, ctx: ChannelAckCtx) => ChannelMessage | null) | null;
  /** Extra server-side filter, composed AND with the mandatory self-message guard. */
  filter?: string;
  /**
   * Only start a NEW session when an event matches this filter; existing threads always resume. Use it
   * to summon the bot on mention, then continue the thread silently, e.g.
   * `startOn: "event.event.text contains '<@U012BOT>'"` (your bot's user id).
   */
  startOn?: string;
  /** "final" (default): ack then one edit. "stream": debounced live edits (fast-follow). */
  delivery?: "final" | "stream";
  /**
   * Lifecycle emoji reactions on the user's message (names without colons, e.g. "eyes"): `working` is
   * added while the turn runs and swapped to `done`, or `error` on failure. Needs the `reactions:write`
   * scope. The agent can also react itself via `run({ channel })`.
   */
  reactions?: ChannelReactions<TEvent>;
  /** Override the Slack Web API base URL (for testing against a mock). */
  apiBaseUrl?: string;
};

/**
 * Build a predicate that matches when the bot is @mentioned, for `startOn` (summon-on-mention) or
 * `filter`. Pass your bot's user id(s) from the Slack app (they start with `U`); matches both the plain
 * `<@U012BOT>` and labelled `<@U012BOT|name>` mention forms:
 * `slack({ id, token, startOn: mentions("U012BOT") })`.
 */
export function mentions(...botUserIds: string[]): string {
  const ids = botUserIds.filter(Boolean);
  if (ids.length === 0) throw new Error("mentions() requires at least one bot user id");
  const clauses = ids.flatMap((id) => [
    `event.event.text contains '<@${id}>'`,
    `event.event.text contains '<@${id}|'`,
  ]);
  return `(${clauses.join(" || ")})`;
}

/**
 * Slack as a chat frontend for an agent. List on `chat.agent({ channels: [slack({...})] })`: verified
 * Slack messages in a thread are routed to a durable per-thread session and run as turns, and the reply
 * is posted back to the thread. Set the endpoint's signing secret to your Slack signing secret; pass the
 * bot token as `token`. Subscribe the app to `message.channels` (and invite the bot to the channel).
 */
export function slack<TEvent = SlackMessageEvent>(
  options: SlackChannelOptions<TEvent>
): ChannelConnector<TEvent> {
  const apiBaseUrl = options.apiBaseUrl ?? SLACK_API_BASE_URL;
  const source: WebhookSource<TEvent> = {
    provider: "slack",
    verifier: { kind: "config", config: SLACK_VERIFIER, handshake: SLACK_HANDSHAKE },
    secretProvisioning: "integrator",
  };
  const messageFilter = options.filter
    ? `${SELF_MESSAGE_GUARD} && (${options.filter})`
    : SELF_MESSAGE_GUARD;
  const filter = `${INTERACTIVITY_PASS} || (${messageFilter})`;
  const ack =
    options.ack === null
      ? undefined
      : (options.ack ??
        ((_event: TEvent, ctx: ChannelAckCtx) => ({
          text: ctx.recovered ? "picking this back up..." : "on it...",
        })));

  return chat.channels.custom<WebhookSource<TEvent>>({
    id: options.id,
    source,
    key: options.key ?? DEFAULT_KEY,
    inbound: options.inbound ?? (defaultSlackInbound as (event: TEvent) => ChannelMessageInput),
    outbound: options.outbound ?? defaultSlackOutbound,
    ack,
    send: makeSlackSend(options.token, apiBaseUrl),
    renderInteraction: defaultSlackRenderInteraction as (
      pending: ChannelPendingToolCall[],
      ctx: ChannelInteractionCtx<TEvent>
    ) => ChannelMessage | null,
    onInteraction: defaultSlackOnInteraction as (
      event: TEvent
    ) => ChannelInteractionResolution | null,
    finalizeInteraction: defaultSlackFinalizeInteraction as (
      event: TEvent,
      resolution: ChannelInteractionResolution
    ) => Promise<void>,
    // Composed at runtime (guard + optional user filter), so it bypasses the literal-only filter
    // validator; the user's `filter` arg was already validated on the way in.
    filter: filter as never,
    startOn: options.startOn as never,
    delivery: options.delivery ?? "final",
    react: makeSlackReact(options.token, apiBaseUrl),
    reactions: options.reactions,
  });
}

/**
 * Cap for the serialized tool input in an approval block. A Slack section `text` field accepts about
 * 3000 characters; staying well under keeps a large input from failing chat.postMessage with
 * `invalid_blocks` and dropping the approval controls.
 */
const MAX_INTERACTION_INPUT_CHARS = 2500;

/**
 * Default HITL controls: render each pending human-decision tool as a Block Kit approve/deny pair. The
 * button `value` carries `${toolCallId}::${decision}` so `onInteraction` can resolve the exact tool.
 */
function defaultSlackRenderInteraction(
  pending: ChannelPendingToolCall[],
  _ctx: ChannelInteractionCtx<unknown>
): ChannelMessage | null {
  if (pending.length === 0) return null;

  const blocks = pending.flatMap((call) => {
    let detail = "";
    if (call.input !== undefined) {
      const serialized = safeStringify(call.input);
      const shown =
        serialized.length > MAX_INTERACTION_INPUT_CHARS
          ? serialized.slice(0, MAX_INTERACTION_INPUT_CHARS) + "\n... (truncated)"
          : serialized;
      detail = "\n```" + shown + "```";
    }
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Approval needed* for \`${call.toolName}\`${detail}` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "trigger_hitl_approve",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value: `${call.toolCallId}::approve`,
          },
          {
            type: "button",
            action_id: "trigger_hitl_deny",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            value: `${call.toolCallId}::deny`,
          },
        ],
      },
    ];
  });

  return {
    text:
      pending.length === 1
        ? `Approval needed: ${pending[0]!.toolName}`
        : `Approval needed: ${pending.length} tool calls`,
    blocks,
  };
}

/**
 * Default interaction resolver: a `block_actions` button click resolves the tool named in its `value`
 * (`${toolCallId}::approve|deny`) to `{ approved }`. Any non-interactivity event returns null (the
 * normal message path handles it).
 */
function defaultSlackOnInteraction(event: unknown): ChannelInteractionResolution | null {
  const payload = event as { type?: string; actions?: Array<{ value?: string }> };
  if (payload?.type !== "block_actions") return null;
  const action = (payload.actions ?? []).find(
    (a) => typeof a?.value === "string" && a.value.includes("::")
  );
  if (!action?.value) return null;
  const [toolCallId, decision] = action.value.split("::");
  if (!toolCallId || (decision !== "approve" && decision !== "deny")) return null;
  return { toolCallId, output: { approved: decision === "approve" } };
}

/**
 * After a decision, collapse the controls via the interaction's `response_url` (Slack's documented path:
 * the click gets a bare 200 ack, then `response_url` accepts `replace_original` for up to 30 minutes).
 * Keeps the original context blocks, drops ONLY the resolved tool call's `actions` block (so approve/deny
 * controls for any other pending tool calls in the same message survive), and appends the outcome. No-op
 * when the payload carries no `response_url` (e.g. a synthetic test event).
 */
async function defaultSlackFinalizeInteraction(
  event: unknown,
  resolution: ChannelInteractionResolution
): Promise<void> {
  const payload = event as {
    response_url?: string;
    user?: { id?: string };
    message?: { blocks?: unknown[] };
  };
  const responseUrl = payload?.response_url;
  if (!responseUrl) return;

  const approved = (resolution.output as { approved?: boolean } | undefined)?.approved === true;
  const decision = approved ? "Approved" : "Denied";
  const icon = approved ? ":white_check_mark:" : ":x:";
  const who = payload.user?.id ? ` by <@${payload.user.id}>` : "";

  const original = Array.isArray(payload.message?.blocks) ? payload.message!.blocks : [];
  const resolvedPrefix = `${resolution.toolCallId}::`;
  const kept = original.filter((block) => {
    const actionBlock = block as { type?: string; elements?: Array<{ value?: string }> };
    return (
      actionBlock.type !== "actions" ||
      !actionBlock.elements?.some((element) => element.value?.startsWith(resolvedPrefix))
    );
  });
  const blocks = [
    ...kept,
    { type: "context", elements: [{ type: "mrkdwn", text: `${icon} *${decision}*${who}` }] },
  ];

  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replace_original: true, text: `${decision}${who}`, blocks }),
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Strip a leading bot mention (`<@U123> hi` -> `hi`) so the agent sees the plain text.
function defaultSlackInbound(event: SlackMessageEvent): string {
  return (event.event?.text ?? "").replace(/^\s*<@[A-Z0-9]+>\s*/i, "");
}

/**
 * Convert common GitHub-flavored markdown (what a model emits) to Slack mrkdwn: `**bold**` -> `*bold*`,
 * `#` headings -> bold, `-`/`*` bullets -> `•`, `[t](url)` -> `<url|t>`, `~~s~~` -> `~s~`. Applied by the
 * default outbound; a custom `outbound` controls its own formatting (call this from it if you want it).
 * Note: single-asterisk `*italic*` is left as-is, so it renders bold in Slack (rare in model output).
 */
export function toSlackMrkdwn(md: string): string {
  return md
    .replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]{1,2000})\)/g, "<$2|$1>")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
}

function defaultSlackOutbound(reply: ChannelReply): ChannelMessage | null {
  return reply.text ? { text: toSlackMrkdwn(reply.text) } : null;
}

function makeSlackSend<TEvent>(token: SlackToken<TEvent>, apiBaseUrl: string) {
  return async (
    message: ChannelMessage,
    ctx: ChannelSendCtx<TEvent>
  ): Promise<{ ref?: string }> => {
    const event = ctx.event as SlackMessageEvent & {
      container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
      channel?: { id?: string };
    };
    const channel = event.event?.channel ?? event.container?.channel_id ?? event.channel?.id;
    const threadTs =
      event.event?.thread_ts ??
      event.event?.ts ??
      event.container?.thread_ts ??
      event.container?.message_ts;

    const resolve = () => (typeof token === "function" ? token(ctx.event) : token);
    let botToken = await resolve();

    const blocks = (message as { blocks?: unknown }).blocks;
    const rich = Array.isArray(blocks) && blocks.length > 0 ? { blocks } : {};

    const post = async () =>
      ctx.previousRef
        ? slackApi(apiBaseUrl, "chat.update", botToken, {
            channel,
            ts: ctx.previousRef,
            text: message.text,
            ...rich,
          })
        : slackApi(apiBaseUrl, "chat.postMessage", botToken, {
            channel,
            thread_ts: threadTs,
            text: message.text,
            ...rich,
          });

    let result = await post();
    // Re-resolve once on an auth error (token rotation) when a resolver was supplied.
    if (!result.ok && typeof token === "function" && isAuthError(result.error)) {
      botToken = await resolve();
      result = await post();
    }
    if (!result.ok) {
      // not_in_channel / channel_not_found is the common one: the bot isn't in the channel. Surface it.
      throw new Error(
        `slack ${ctx.previousRef ? "chat.update" : "chat.postMessage"} failed: ${result.error}`
      );
    }
    return { ref: ctx.previousRef ?? result.ts };
  };
}

function isAuthError(error: string | undefined): boolean {
  return error === "invalid_auth" || error === "token_revoked" || error === "account_inactive";
}

// Add/remove an emoji reaction on the triggering Slack message (needs the reactions:write scope).
function makeSlackReact<TEvent>(token: SlackToken<TEvent>, apiBaseUrl: string) {
  return async (reaction: ChannelReaction, ctx: ChannelReactCtx<TEvent>): Promise<void> => {
    const event = ctx.event as SlackMessageEvent;
    const channel = event.event?.channel;
    const timestamp = event.event?.ts;
    const name = reaction.name.replace(/^:|:$/g, "");
    if (!channel || !timestamp || !name) return;
    const botToken = typeof token === "function" ? await token(ctx.event) : token;
    const method = reaction.remove ? "reactions.remove" : "reactions.add";
    const result = await slackApi(apiBaseUrl, method, botToken, { channel, timestamp, name });
    // already_reacted / no_reaction are benign idempotent outcomes; surface anything else.
    if (!result.ok && result.error !== "already_reacted" && result.error !== "no_reaction") {
      throw new Error(`slack ${method} failed: ${result.error}`);
    }
  };
}

async function slackApi(
  baseUrl: string,
  method: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; ts?: string; error?: string };
}

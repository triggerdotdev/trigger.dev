import { logger } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import type {
  ChannelCancelledToolCall,
  ChannelConnector,
  ChannelControl,
  ChannelDownloadedFile,
  ChannelInteractionCtx,
  ChannelInteractionResolution,
  ChannelLifecycleCtx,
  ChannelLifecycleState,
  ChannelMessage,
  ChannelErrorMessage,
  ChannelInbound,
  ChannelMessageInput,
  ChannelPendingToolCall,
  ChannelProgressEvent,
  ChannelReaction,
  ChannelReactCtx,
  ChannelReply,
  ChannelReplyStream,
  ChannelReplyStreamEnd,
  ChannelSeedMessage,
  ChannelSendCtx,
  ChannelStreamCtx,
  ChannelTurnCtx,
  ChannelRunSurface,
} from "@trigger.dev/sdk/ai";
import type {
  ValidateWebhookFilter,
  WebhookEndpoint,
  WebhookHandshakeConfig,
  WebhookHmacConfig,
  WebhookSource,
} from "@trigger.dev/core/v3";
import { webhookProviderConfigs } from "@trigger.dev/core/webhooks";

// A minimal Slack Events API envelope; pass your own event type for fuller typing.
/**
 * The form fields Slack posts to a slash command's Request URL. Reply through `response_url` (up to
 * five times within 30 minutes) or with the Web API.
 */
export type SlackSlashCommand = {
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  user_id: string;
  user_name?: string;
  channel_id: string;
  channel_name?: string;
  team_id: string;
  team_domain?: string;
  enterprise_id?: string;
  api_app_id?: string;
};

/**
 * A file on a Slack message (`files` on a `file_share` message). `url_private` and the thumbnails
 * need the bot token, with the `files:read` scope, to download.
 */
export type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  /** `tombstone` when the file was deleted. */
  mode?: string;
  /** `check_file_info` when the file is from another workspace and not readable from the event. */
  file_access?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_960?: string;
  thumb_1024?: string;
};

export type SlackMessageEvent = {
  type: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type: string;
    subtype?: string;
    text?: string;
    user?: string;
    user_team?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    event_ts?: string;
    bot_id?: string;
    /** `im` for the agent's own conversation, `channel` or `group` for a channel thread. */
    channel_type?: string;
    /** On `agent_session_stopped`: the streaming messages the stop button ended. */
    streaming_message_ts?: string[];
    files?: SlackFile[];
  };
};

// Slack signs `X-Slack-Signature: v0=<hex>` over `v0:{timestamp}:{body}`; the timestamp rides in
// `X-Slack-Request-Timestamp`. You paste the Slack signing secret as the endpoint's signing secret.
const SLACK_VERIFIER: WebhookHmacConfig = webhookProviderConfigs.slack.config();

// Slack's Event Subscriptions url_verification handshake: echo the challenge, do not record/route.
const SLACK_HANDSHAKE: WebhookHandshakeConfig = {
  matchPath: "type",
  matchValue: "url_verification",
  respondPath: "challenge",
};

/**
 * One session per Slack thread, which is one Slack agent session. Message events, `block_actions`
 * clicks on the approval controls and `agent_session_stopped` all converge on it: thread_ts is only
 * on replies, so a thread-starting message falls back to ts, and interactivity carries the thread
 * on its container, or on the clicked message when the container omits it. The `||` operator
 * resolves to the first non-empty path.
 */
const DEFAULT_KEY =
  "{event.team_id || event.team.id}:{event.event.channel || event.container.channel_id}:{event.event.thread_ts || event.event.ts || event.container.thread_ts || event.message.thread_ts || event.container.message_ts}";

const SLACK_SETUP_PROMPT = [
  "These settings live in the Slack app's dashboard (https://api.slack.com/apps). The fastest path is the app manifest in the Trigger.dev Slack docs; change it through apps.manifest.update if you have an app configuration token, otherwise tell the user each step.",
  "1. Agents & AI Apps: turn on the agent experience (the manifest's features.agent_view, with an agent_description). This adds the assistant:write scope.",
  "2. Event Subscriptions: turn it on and set the Request URL to the endpoint URL. Slack sends a signed url_verification request, which the endpoint answers once its signing secret is set (step 5); until then Slack shows the URL as not verified, so set the secret first and then click Verify.",
  '3. Under "Subscribe to bot events", add message.im (conversations with the agent), agent_session_stopped (the stop button), and, if the agent should also answer in channels, app_mention (an @mention starts a session) plus message.channels or message.groups (to follow the thread afterwards). Save.',
  "4. Interactivity & Shortcuts: turn it on and set the Request URL to the same endpoint URL, so the agent's buttons (approvals and its own) reach it.",
  "5. The signing secret is under Basic Information > App Credentials > Signing Secret.",
  "6. OAuth & Permissions: the bot token needs assistant:write, chat:write, files:read (images and PDFs users share with the agent), reactions:write and im:history, plus app_mentions:read and channels:history or groups:history for channels. Reinstall the app if scopes changed, and invite the bot to any channel it should answer in.",
].join("\n");

/**
 * `startOn` for an agent that answers in a channel when it is @mentioned, from Slack's `app_mention`
 * event (subscribe to it, with the `app_mentions:read` scope). Needs no bot user id. Slack also sends
 * the mention as a channel `message` event; the connector ignores that copy, so one mention runs one
 * turn. Replies later in the thread arrive as `message` events and continue the session.
 */
export function appMentions(): string {
  return APP_MENTION;
}

const APP_MENTION = "event.event.type == 'app_mention'";

/** An @mention of the app, admitted only when `startOn` uses {@link appMentions}. */
const APP_MENTION_GUARD = `${APP_MENTION} && event.event.bot_id == null`;

/**
 * True for the channel `message` copy of an @mention of this bot, which Slack sends alongside the
 * `app_mention` event. The bot's user id comes from the event's `authorizations`.
 */
function isMentionMessageCopy(event: unknown): boolean {
  const e = event as {
    authorizations?: Array<{ user_id?: string }>;
    event?: { type?: string; channel_type?: string; text?: string };
  };
  const botUserId = e.authorizations?.[0]?.user_id;
  if (!botUserId || e.event?.type !== "message" || e.event.channel_type === "im") return false;
  const text = e.event.text ?? "";
  return text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`);
}

/** The sender of a message or mention is in the receiving workspace (Slack Connect guests aren't). */
const OWN_WORKSPACE_MESSAGE =
  "(event.event.user_team == null || event.event.user_team == event.team_id)";
/** The user who clicked is in the receiving workspace. */
const OWN_WORKSPACE_CLICK = "(event.user.team_id == null || event.user.team_id == event.team.id)";

/**
 * Mandatory loop guard for MESSAGE events: `bot_id == null` drops the agent's own posts (no reply loop);
 * the subtype allowlist keeps real user messages (absent subtype matches `null`) and drops system/edit
 * events. Interactivity and stops are separate surfaces, admitted ahead of the user's `filter`.
 */
const SELF_MESSAGE_GUARD =
  "event.event.type == 'message' && event.event.bot_id == null && event.event.subtype in [null,'file_share','thread_broadcast']";

/** `action_id` prefix of a button that answers a pending tool call (built by an interaction's `button`). */
const TOOL_BUTTON_PREFIX = "trigger_tool_";
/** `action_id` prefix of a button that sends the agent an action (built by `slackButton`). */
const ACTION_BUTTON_PREFIX = "trigger_action_";
/** Slack's cap on a button `value`. */
const MAX_BUTTON_VALUE_CHARS = 2000;

/**
 * Clicks on buttons the connector built (tool answers and agent actions) pass the loop guard.
 * Clicks on any other buttons never reach the agent, so a `webhook()` on the same endpoint can own
 * them.
 */
const INTERACTIVITY_PASS =
  "event.type == 'block_actions' && event.actions any ( action_id startsWith 'trigger_' )";

/** The native stop button, admitted regardless of the user's filter; onControl turns it into a stop. */
const STOP_PASS = "event.event.type == 'agent_session_stopped'";

/** Clicks and stops only ever resume an existing session: neither can start a conversation. */
/** A message in the agent's own conversation (its Messages tab) always starts a session. */
const DIRECT_MESSAGE = "event.event.channel_type == 'im'";

const STARTS_A_SESSION =
  "event.type != 'block_actions' && event.event.type != 'agent_session_stopped'";

const SLACK_API_BASE_URL = "https://slack.com/api";

/** Slack caps an agent session title at 200 characters. */
const SLACK_TITLE_MAX = 200;

export type SlackToken<TEvent> = string | ((event: TEvent) => string | Promise<string>);

/**
 * The agent session `slack()` binds a Slack conversation to: the thread to post and stream into
 * without an inbound event, and the user the agent is answering (Slack's stream recipient). A turn
 * that no Slack message started (a `chat.event` action that returns `chat.turn()`, a browser
 * message on the same session) answers into this thread, for this user.
 */
export type SlackThreadHandle = {
  teamId?: string;
  channel: string;
  threadTs: string;
  /** The Slack user the latest message came from. */
  userId?: string;
  /** That user's team, when it differs from the workspace (Enterprise Grid, Slack Connect). */
  userTeamId?: string;
};

/**
 * A Slack `block_actions` payload, a button click. A channel action's `onAction` gets it as
 * `channel.event`: who clicked (`user`), the message the button was on (`container`, `message`), and a
 * `response_url` for editing that message.
 */
export type SlackBlockActions = {
  type: "block_actions";
  team?: { id?: string; domain?: string };
  user?: { id?: string; username?: string; name?: string; team_id?: string };
  channel?: { id?: string; name?: string };
  container?: { type?: string; channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
  response_url?: string;
  trigger_id?: string;
  actions: Array<{
    action_id: string;
    block_id?: string;
    value?: string;
    text?: { type?: string; text?: string };
    action_ts?: string;
  }>;
};

/** A Block Kit button, as `slackButton()` and an interaction's `button()` build it. */
export type SlackButton = {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string; emoji: true };
  value: string;
  style?: "primary" | "danger";
  confirm?: {
    title: { type: "plain_text"; text: string };
    text: { type: "plain_text"; text: string };
    confirm: { type: "plain_text"; text: string };
    deny: { type: "plain_text"; text: string };
  };
};

export type SlackButtonOptions = {
  text: string;
  style?: "primary" | "danger";
  /** Ask before sending the click: Slack shows this dialog first. */
  confirm?: { title: string; text: string; confirm?: string; deny?: string };
};

/** What an interaction renderer posts for a pending tool call: Block Kit blocks and a notification text. */
export type SlackInteractionMessage = { text: string; blocks: unknown[] };

/**
 * Renders the Slack UI for a tool call waiting on the user (a tool with no `execute`). `button()`
 * builds a button whose click resolves the call with `output`, which becomes the tool's result.
 * Return null to post nothing for the call.
 */
export type SlackInteractionRenderer = (
  call: ChannelPendingToolCall,
  ui: { button: (options: SlackButtonOptions & { output: unknown }) => SlackButton }
) => SlackInteractionMessage | null;

/**
 * Helpers `slack()` adds to the run's channel surface (`run({ channel })`, or `chat.surface()`
 * from a tool's `execute`).
 */
export type SlackSurface = {
  /** Post a message into the session's thread, for example buttons built with `slackButton()`. */
  post: (message: { text: string; blocks?: unknown[] }) => Promise<{ ts: string }>;
};

/**
 * What `run({ channel })` carries on a Slack turn, and what `chat.surface<SlackRunSurface>()` returns:
 * the {@link SlackSurface} helpers plus `react`/`unreact`.
 */
export type SlackRunSurface = ChannelRunSurface<SlackSurface>;

/**
 * A button that sends the agent `action` when clicked: it reaches `onAction`, validated against the
 * agent's `actionSchema`, and returning `chat.turn()` answers in the thread. Post it with the
 * surface's `post()`.
 *
 * @example
 * ```ts
 * await chat.surface<SlackRunSurface>()?.post({
 *   text: "Anything else?",
 *   blocks: [{ type: "actions", elements: [slackButton({ text: "Explain more", action: { type: "explain" } })] }],
 * });
 * ```
 */
export function slackButton(options: SlackButtonOptions & { action: unknown }): SlackButton {
  const id = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return buildButton(
    `${ACTION_BUTTON_PREFIX}${id}`,
    encodeButtonValue(options.action, options.text),
    options
  );
}

function encodeButtonValue(value: unknown, text: string): string {
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > MAX_BUTTON_VALUE_CHARS) {
    throw new Error(
      `slack(): the "${text}" button carries ${encoded.length} characters; Slack allows ${MAX_BUTTON_VALUE_CHARS}`
    );
  }
  return encoded;
}

function buildButton(actionId: string, value: string, options: SlackButtonOptions): SlackButton {
  const plain = (text: string) => ({ type: "plain_text" as const, text });
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: options.text, emoji: true },
    value,
    ...(options.style ? { style: options.style } : {}),
    ...(options.confirm
      ? {
          confirm: {
            title: plain(options.confirm.title),
            text: plain(options.confirm.text),
            confirm: plain(options.confirm.confirm ?? "Confirm"),
            deny: plain(options.confirm.deny ?? "Cancel"),
          },
        }
      : {}),
  };
}

export type SlackChannelOptions<
  TEvent,
  TFilter extends string = string,
  TStartOn extends string = string,
> = {
  id: string;
  /** The endpoint to subscribe to, declared with `webhooks.endpoint.define({ id, source: webhookSource() })`. */
  endpoint: WebhookEndpoint<TEvent>;
  /** Bot token (xoxb-...). A string for one workspace, or a resolver keyed on the event's team_id. */
  token: SlackToken<TEvent>;
  /**
   * Session key template over `{event.x}`, `{header.x}` and `{webhook.x}` placeholders. Defaults to one
   * session per thread, which is one Slack agent session.
   */
  key?: string;
  /**
   * Map a Slack event to the turn's message. Defaults to the message text with the bot mention
   * stripped, attributed to the Slack user (`externalUserId`) and message (`externalMessageId`),
   * plus the images and PDFs shared with it as file parts. The transcript keeps each file's Slack
   * URL; the `streamText` given to `run()` downloads it with the bot token when the model reads it.
   * A file the model can't read (another type, too large, deleted) becomes a short note instead.
   */
  inbound?: (event: TEvent) => ChannelInbound;
  /**
   * Map the agent's reply to a Slack message when it is posted rather than streamed (`delivery:
   * "final"`, or a turn that streamed nothing). Defaults to the reply's markdown; return `blocks`
   * for Block Kit. Null posts nothing.
   */
  outbound?: (reply: ChannelReply) => ChannelMessage | null;
  /** Extra server-side filter for message events, composed AND with the mandatory self-message guard. */
  filter?: ValidateWebhookFilter<TEvent, TFilter>;
  /**
   * Required: which channel messages start a NEW session. Existing threads always resume, and a
   * message in the agent's own conversation always starts one. Usually {@link appMentions}: the agent
   * answers in a channel only when it is @mentioned, then follows that thread (subscribe the app to
   * `app_mention`). `mentions("U012BOT")` does the same from message events with your bot's user id,
   * `"event.event.type == 'message'"` answers every message it can see, and
   * `"event.event.channel_type == 'im'"` answers only in its own conversation.
   */
  startOn: ValidateWebhookFilter<TEvent, TStartOn>;
  /**
   * "stream" (default): the reply streams into the thread as the model writes it, through Slack's
   * `chat.startStream` / `chat.appendStream` / `chat.stopStream`, with tool calls as task cards.
   * "final": the reply is posted once when the turn ends.
   */
  delivery?: "stream" | "final";
  /**
   * The agent session's title, set once when Slack creates the session on the first turn; a title
   * the user sets in Slack is never overwritten. Defaults to the first prompt, cut to 200
   * characters. Return null to leave Slack's own title.
   */
  title?: (prompt: string, event: TEvent | undefined) => string | null;
  /**
   * How the turn's tool calls show in the streamed reply. `"plan"` (default) groups them in one plan
   * block whose title says whether the turn is working, done or stopped; `"tasks"` shows one task card
   * per call between the reply's text; `"off"` shows none. A task's title is the tool's `title`
   * (`tool({ title })`), or else its name made readable (`searchArchive` shows "Search archive").
   */
  progress?: "plan" | "tasks" | "off";
  /**
   * When the agent is summoned into a thread that already has messages, load that thread's history
   * into the new session so the agent answers with the context a reader of the thread has. Reads
   * `conversations.replies` with the bot token (needs `channels:history`, which receiving messages
   * already requires). `limit` caps how many prior messages are loaded (default 50, newest kept).
   * Off by default: it is one extra API call per new thread session, more for long threads. Newly
   * created non-Marketplace apps are on Slack's restricted tier for this method (15 results, one
   * call per minute); they seed at most the first 15 replies and a rate limit never fails the turn.
   */
  seedFromThread?: boolean | { limit?: number };
  /**
   * The emoji added, as soon as it arrives, to a message sent while the agent is still answering:
   * it is either folded into the reply (`pendingMessages`) or answered right after. Default
   * `"eyes"`; null adds none. Needs the `reactions:write` scope.
   */
  receivedReaction?: string | null;
  /**
   * What the reply shows when a turn fails (a model or provider error), in place of the error. A
   * fixed line, or a function of the failure (`error`, `partialText`, `event`, `runId`, `chatId`)
   * that returns one. Defaults to "Something went wrong answering this. Try again." The error is
   * logged on the run.
   */
  errorMessage?: ChannelErrorMessage<TEvent>;
  /**
   * Only answer people from the workspace the app is installed in. Messages, mentions and button
   * clicks from Slack Connect guests (another organization's users in a shared channel) are dropped
   * before they reach the agent. In Enterprise Grid this also drops users whose home workspace is
   * another workspace in the org.
   */
  ownWorkspaceOnly?: boolean;
  /**
   * Slack UI for tools with no `execute`, keyed by tool name. The renderer's `button()` builds
   * buttons whose click becomes the tool's output, so a tool can ask the user to pick, confirm or
   * choose and continue with the answer. A tool without an entry gets `approval`.
   */
  interactions?: Record<string, SlackInteractionRenderer>;
  /**
   * The UI for a tool with no `execute` and no `interactions` entry. Defaults to Approve and Deny
   * buttons that resolve the tool to `{ approved: boolean }`.
   */
  approval?: SlackInteractionRenderer;
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
 * The Slack source for `webhooks.endpoint.define({ id, source: webhookSource() })`: HMAC signature
 * verification, the one-time `url_verification` handshake Slack requires before an Event
 * Subscriptions URL can be saved, form-encoded interactivity and slash command parsing, an empty 200
 * acknowledgement (Slack shows a non-empty slash command reply to the user), and a setup prompt.
 * Paste your Slack app's Signing Secret as the endpoint secret. Subscribe `webhook()` tasks to the
 * endpoint, or pass it to `slack({ endpoint })` for a chat-agent frontend. For slash commands, type
 * the endpoint with `webhookSource<SlackSlashCommand>()`.
 */
export function webhookSource<TEvent = SlackMessageEvent>(): WebhookSource<TEvent> {
  return {
    provider: "slack",
    verifier: {
      kind: "config",
      config: SLACK_VERIFIER,
      handshake: SLACK_HANDSHAKE,
      response: { acceptedBody: "empty" },
    },
    secretProvisioning: "provider",
    setupPrompt: SLACK_SETUP_PROMPT,
  };
}

/**
 * Slack agents as a chat frontend for an agent. List on `chat.agent({ channels: [slack({...})] })`: a
 * user messages the agent (in its Slack conversation, or a thread in a channel it is in), Slack opens
 * an agent session, and the connector routes it to a durable Trigger.dev session keyed on the thread.
 * The session shows the agent's status while it works, the reply streams in natively with tool calls
 * as task cards, a tool with no `execute` posts Approve and Deny buttons, and Slack's stop button stops
 * the turn. Declare the app with `agent_view`, pass an endpoint declared with `webhookSource()`, set
 * its signing secret to the Slack signing secret, and pass the bot token as `token`.
 *
 * @example
 * ```ts
 * const slackEvents = webhooks.endpoint.define({ id: "slack", source: webhookSource() });
 * export const agent = chat.agent({
 *   id: "support",
 *   channels: [
 *     slack({
 *       id: "slack",
 *       endpoint: slackEvents,
 *       token: process.env.SLACK_BOT_TOKEN!,
 *       startOn: appMentions(),
 *     }),
 *   ],
 *   run: async ({ messages, signal, streamText }) =>
 *     streamText({ model, messages, abortSignal: signal }),
 * });
 * ```
 */
export function slack<
  TEvent = SlackMessageEvent,
  const TFilter extends string = string,
  const TStartOn extends string = string,
>(
  options: SlackChannelOptions<TEvent, TFilter, TStartOn>
): ChannelConnector<TEvent, SlackThreadHandle> {
  const apiBaseUrl = options.apiBaseUrl ?? SLACK_API_BASE_URL;
  if (!options.endpoint?.id) {
    throw new Error(
      `slack("${options.id}"): an endpoint is required. Declare one with webhooks.endpoint.define({ id, source: webhookSource() }) and pass it as { endpoint }.`
    );
  }
  if (options.endpoint.source !== "slack") {
    throw new Error(
      `slack("${options.id}"): endpoint "${options.endpoint.id}" has source "${options.endpoint.source}". Declare it with webhooks.endpoint.define({ id, source: webhookSource() }) from @trigger.dev/slack.`
    );
  }
  const byAppMention = String(options.startOn ?? "").includes(APP_MENTION);
  const messageGuard = byAppMention
    ? `(${SELF_MESSAGE_GUARD}) || (${APP_MENTION_GUARD})`
    : SELF_MESSAGE_GUARD;
  const messageFilter = options.filter
    ? byAppMention
      ? `(${messageGuard}) && (${options.filter})`
      : `${messageGuard} && (${options.filter})`
    : messageGuard;
  const inbound = options.inbound ?? (defaultSlackInbound as (event: TEvent) => ChannelInbound);
  const filter = options.ownWorkspaceOnly
    ? `(${INTERACTIVITY_PASS} && ${OWN_WORKSPACE_CLICK}) || ${STOP_PASS} || ((${messageFilter}) && ${OWN_WORKSPACE_MESSAGE})`
    : `${INTERACTIVITY_PASS} || ${STOP_PASS} || (${messageFilter})`;
  if (!options.startOn) {
    throw new Error(
      `slack("${options.id}"): startOn is required. Pass startOn: appMentions() to answer in a channel only when the agent is @mentioned (subscribe the Slack app to app_mention), mentions("<bot user id>") to do the same from message events, "event.event.type == 'message'" to answer every message, or "event.event.channel_type == 'im'" to answer only in the agent's own conversation.`
    );
  }
  const startOn = `${STARTS_A_SESSION} && (${DIRECT_MESSAGE} || (${options.startOn}))`;
  const delivery = options.delivery ?? "stream";
  const api = makeSlackApi(options.token, apiBaseUrl);
  const react = makeSlackReact(api);
  const renderInteraction = makeSlackRenderInteraction(
    options.interactions ?? {},
    options.approval ?? defaultSlackApproval
  );

  return chat.channels.custom<WebhookEndpoint<TEvent>, string, string, string, SlackThreadHandle>({
    id: options.id,
    endpoint: options.endpoint,
    key: options.key ?? DEFAULT_KEY,
    inbound: byAppMention
      ? (event: TEvent) => (isMentionMessageCopy(event) ? { message: "" } : inbound(event))
      : inbound,
    bind: slackThreadHandle as (event: TEvent) => SlackThreadHandle | null,
    ...(options.seedFromThread
      ? {
          seed: makeSlackSeed<TEvent>(
            options.token,
            apiBaseUrl,
            seedLimit(
              typeof options.seedFromThread === "object" ? options.seedFromThread.limit : undefined
            )
          ),
        }
      : {}),
    outbound: options.outbound ?? defaultSlackOutbound,
    send: makeSlackSend(api),
    ...(delivery === "stream"
      ? { stream: makeSlackStream(api, { progress: options.progress ?? "plan" }) }
      : {}),
    endInterruptedStream: makeSlackEndInterruptedStream(api),
    download: makeSlackDownload(api, apiBaseUrl) as (
      url: URL,
      ctx: { handle?: SlackThreadHandle }
    ) => Promise<ChannelDownloadedFile | null>,
    lifecycle: makeSlackLifecycle(api, options.title ?? defaultSlackTitle),
    onControl: slackControl as (event: TEvent) => ChannelControl | null,
    renderInteraction: renderInteraction as (
      pending: ChannelPendingToolCall[],
      ctx: ChannelInteractionCtx<TEvent>
    ) => ChannelMessage | null,
    onInteraction: slackToolAnswer as (event: TEvent) => ChannelInteractionResolution | null,
    finalizeInteraction: slackFinalizeInteraction as (
      event: TEvent,
      resolution: ChannelInteractionResolution
    ) => Promise<void>,
    cancelInteraction: makeSlackCancelInteraction(api, renderInteraction),
    toAction: slackClickAction as (event: TEvent) => unknown | null,
    surface: makeSlackSurface(api) as (
      ctx: ChannelTurnCtx<TEvent, SlackThreadHandle>
    ) => Record<string, unknown>,
    // Composed at runtime (the guards + the optional user filter), so they bypass the literal-only
    // filter validator; the user's `filter` and `startOn` were validated on the way in.
    filter: filter as never,
    startOn: startOn as never,
    delivery,
    errorMessage: options.errorMessage,
    react,
    ...(options.receivedReaction === null
      ? {}
      : {
          received: (ctx: ChannelTurnCtx<TEvent, SlackThreadHandle>) =>
            react(
              { name: options.receivedReaction ?? "eyes" },
              { event: ctx.event as TEvent, deliveryId: ctx.deliveryId ?? "" }
            ),
        }),
  });
}

/** The default session title: the first line of the first prompt, cut to Slack's 200 characters. */
function defaultSlackTitle(prompt: string): string | null {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return null;
  return firstLine.length > SLACK_TITLE_MAX
    ? firstLine.slice(0, SLACK_TITLE_MAX - 3) + "..."
    : firstLine;
}

/**
 * Slack's stop button (`agent_session_stopped`) as a channel stop: it aborts the running turn, is
 * dropped when nothing is running (and cancels a pending approval), and a stop pressed before the
 * running turn started is ignored.
 */
export function slackControl(event: SlackMessageEvent): ChannelControl | null {
  if (event?.event?.type !== "agent_session_stopped") return null;
  const pressedAt = Number(event.event.event_ts);
  return {
    kind: "stop",
    message: "stopped from Slack",
    whenIdle: "drop",
    ...(Number.isFinite(pressedAt) && pressedAt > 0 ? { at: Math.floor(pressedAt * 1000) } : {}),
  };
}

/**
 * Cap for the serialized tool input in an approval block. A Slack section `text` field accepts about
 * 3000 characters; staying well under keeps a large input from failing chat.postMessage with
 * `invalid_blocks` and dropping the approval controls.
 */
const MAX_INTERACTION_INPUT_CHARS = 2500;

/**
 * The default approval UI: the tool and its input, with Approve and Deny buttons resolving the call
 * to `{ approved }`.
 */
function defaultSlackApproval(
  call: ChannelPendingToolCall,
  ui: Parameters<SlackInteractionRenderer>[1]
): SlackInteractionMessage {
  let detail = "";
  if (call.input !== undefined) {
    const serialized = safeStringify(call.input);
    const shown =
      serialized.length > MAX_INTERACTION_INPUT_CHARS
        ? serialized.slice(0, MAX_INTERACTION_INPUT_CHARS) + "\n... (truncated)"
        : serialized;
    detail = "\n```" + shown + "```";
  }
  return {
    text: `Approval needed: ${call.toolName}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Approval needed* for \`${call.toolName}\`${detail}` },
      },
      {
        type: "actions",
        elements: [
          ui.button({ text: "Approve", style: "primary", output: { approved: true } }),
          ui.button({ text: "Deny", style: "danger", output: { approved: false } }),
        ],
      },
    ],
  };
}

/**
 * One message for the turn's pending tool calls, each rendered by its `interactions` entry or by
 * `approval`. Button ids are numbered across the message, so every button is unique; each `value`
 * carries the tool call id and the output its click resolves the call to. A renderer that throws
 * gets a note in place of its controls.
 */
function makeSlackRenderInteraction(
  interactions: Record<string, SlackInteractionRenderer>,
  approval: SlackInteractionRenderer
) {
  return (pending: ChannelPendingToolCall[]): ChannelMessage | null => {
    let index = 0;
    const blocks: unknown[] = [];
    const texts: string[] = [];
    for (const call of pending) {
      const render = interactions[call.toolName] ?? approval;
      const button = (options: SlackButtonOptions & { output: unknown }) =>
        buildButton(
          `${TOOL_BUTTON_PREFIX}${index++}`,
          encodeButtonValue({ t: call.toolCallId, o: options.output }, options.text),
          options
        );
      try {
        const rendered = render(call, { button });
        if (!rendered) continue;
        blocks.push(...rendered.blocks);
        texts.push(rendered.text);
      } catch (error) {
        logger.warn("slack(): an interaction renderer threw; posting a note instead", {
          toolName: call.toolName,
          error,
        });
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`${call.toolName}\` is waiting for an answer, but its controls could not be shown.`,
          },
        });
        texts.push(`${call.toolName} is waiting for an answer`);
      }
    }
    if (blocks.length === 0) return null;
    return {
      text: texts.length === 1 ? texts[0]! : `${texts.length} tool calls are waiting for an answer`,
      blocks,
    };
  };
}

type SlackClickedAction = {
  action_id?: string;
  value?: string;
  text?: { text?: string };
};

function clickedButton(event: unknown, prefix: string): SlackClickedAction | undefined {
  const payload = event as { type?: string; actions?: SlackClickedAction[] };
  if (payload?.type !== "block_actions") return undefined;
  return (payload.actions ?? []).find(
    (a) => a?.action_id?.startsWith(prefix) && typeof a.value === "string"
  );
}

function decodeToolValue(value: string | undefined): { t: string; o: unknown } | undefined {
  try {
    const decoded = JSON.parse(value ?? "") as { t?: unknown; o?: unknown };
    return typeof decoded?.t === "string" ? { t: decoded.t, o: decoded.o } : undefined;
  } catch {
    return undefined;
  }
}

/** A click on a tool-answer button resolves its tool call to the button's output. */
function slackToolAnswer(event: unknown): ChannelInteractionResolution | null {
  const decoded = decodeToolValue(clickedButton(event, TOOL_BUTTON_PREFIX)?.value);
  return decoded ? { toolCallId: decoded.t, output: decoded.o } : null;
}

/** A click on a `slackButton()` sends its action to the agent's `onAction`. */
function slackClickAction(event: unknown): unknown | null {
  const button = clickedButton(event, ACTION_BUTTON_PREFIX);
  if (!button) return null;
  try {
    return JSON.parse(button.value!) ?? null;
  } catch {
    return null;
  }
}

/** The surface `post()`: a message into the session's thread with the bot token. */
function makeSlackSurface<TEvent>(api: SlackApi<TEvent>) {
  return (ctx: ChannelTurnCtx<TEvent, SlackThreadHandle>): SlackSurface => ({
    post: async (message) => {
      const handle = threadFor(ctx);
      if (!handle) throw new Error("slack(): no thread to post into");
      const result = await api.call(
        "chat.postMessage",
        {
          channel: handle.channel,
          thread_ts: handle.threadTs,
          text: message.text,
          ...(message.blocks ? { blocks: message.blocks } : {}),
        },
        ctx
      );
      if (!result.ok || !result.ts)
        throw new Error(`slack chat.postMessage failed: ${result.error}`);
      return { ts: result.ts };
    },
  });
}

/**
 * After a decision, collapse the controls via the interaction's `response_url` (Slack's documented path:
 * the click gets a bare 200 ack, then `response_url` accepts `replace_original` for up to 30 minutes).
 * Keeps the original context blocks, drops ONLY the resolved tool call's `actions` block (so approve/deny
 * controls for any other pending tool calls in the same message survive), and appends the outcome. No-op
 * when the payload carries no `response_url` (e.g. a synthetic test event), or when the URL is not a
 * Slack `hooks.slack.com` URL: the payload is signed by Slack, but the worker still only posts to Slack.
 * Throws when Slack rejects the edit, so the runtime logs it.
 */
async function slackFinalizeInteraction(
  event: unknown,
  resolution: ChannelInteractionResolution
): Promise<void> {
  const payload = event as {
    response_url?: string;
    user?: { id?: string };
    message?: { blocks?: unknown[] };
  };
  const responseUrl = payload?.response_url;
  if (!responseUrl || !isSlackResponseUrl(responseUrl)) return;

  const approvedFlag = (resolution.output as { approved?: unknown } | undefined)?.approved;
  const chosen = clickedButton(event, TOOL_BUTTON_PREFIX)?.text?.text;
  const decision =
    typeof approvedFlag === "boolean"
      ? approvedFlag
        ? "Approved"
        : "Denied"
      : chosen || "Answered";
  const icon = typeof approvedFlag === "boolean" && !approvedFlag ? ":x:" : ":white_check_mark:";
  const who = payload.user?.id ? ` by <@${payload.user.id}>` : "";

  const original = Array.isArray(payload.message?.blocks) ? payload.message!.blocks : [];
  const kept = original.filter((block) => {
    const actionBlock = block as { type?: string; elements?: Array<{ value?: string }> };
    return (
      actionBlock.type !== "actions" ||
      !actionBlock.elements?.some(
        (element) => decodeToolValue(element.value)?.t === resolution.toolCallId
      )
    );
  });
  const blocks = [
    ...kept,
    { type: "context", elements: [{ type: "mrkdwn", text: `${icon} *${decision}*${who}` }] },
  ];

  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replace_original: true, text: `${decision}${who}`, blocks }),
  });
  const body = await response.text().catch(() => "");
  let parsed: { ok?: boolean; error?: string } | undefined;
  try {
    parsed = JSON.parse(body) as { ok?: boolean; error?: string };
  } catch {}
  if (!response.ok || parsed?.ok === false) {
    throw new Error(
      `slack: updating the approval message failed (${response.status}${parsed?.error ? ` ${parsed.error}` : ""})`
    );
  }
}

const SLACK_RESPONSE_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

/** Slack interactivity `response_url`s are `https://hooks.slack.com/...` (GovSlack: `hooks.slack-gov.com`). */
export function isSlackResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && SLACK_RESPONSE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Strip a leading bot mention (`<@U123> hi` -> `hi`) so the agent sees the plain text.
function defaultSlackInbound(event: SlackMessageEvent): ChannelInbound {
  const text = (event.event?.text ?? "").replace(/^\s*<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i, "");
  const files = event.event?.files ?? [];
  return {
    message: files.length === 0 ? text : slackMessageWithFiles(text, files),
    externalUserId: event.event?.user,
    externalMessageId: event.event?.ts,
  };
}

/** Image types the major model providers read. */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The smallest per-image cap among the major providers; a larger image is sent as a thumbnail. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** A UI message part for a shared Slack file: a file part on its Slack URL, or a note naming it. */
export type SlackFilePart =
  | { type: "file"; mediaType: string; url: string; filename: string }
  | { type: "text"; text: string };

/**
 * The message parts for a Slack message's shared files, for a custom `inbound`: images and PDFs as
 * file parts on their Slack URL, which the `streamText` passed to `run()` downloads with the bot token,
 * and anything else as a short note naming the file. The default `inbound` uses it.
 *
 * @example
 * ```ts
 * inbound: (event) => ({
 *   message: {
 *     id: event.event?.ts ?? "",
 *     role: "user",
 *     parts: [{ type: "text", text: event.event?.text ?? "" }, ...slackFileParts(event.event?.files)],
 *   },
 * }),
 * ```
 */
export function slackFileParts(files: SlackFile[] | undefined): SlackFilePart[] {
  return (files ?? []).map(slackFilePart);
}

function slackMessageWithFiles(text: string, files: SlackFile[]): ChannelMessageInput {
  const parts: SlackFilePart[] = text.trim() ? [{ type: "text", text }] : [];
  return {
    id: "",
    role: "user",
    parts: [...parts, ...slackFileParts(files)],
  } as ChannelMessageInput;
}

/**
 * A shared Slack file as a model input: images and PDFs become file parts on their Slack URL (an
 * image over the cap uses its largest thumbnail), anything else a note naming the file.
 */
function slackFilePart(file: SlackFile): SlackFilePart {
  const name = file.name || file.title || "file";
  const mediaType = file.mimetype ?? "";
  const note = (reason: string): SlackFilePart => ({
    type: "text",
    text: `[Attached file "${name}" (${mediaType || "unknown type"}) is not available to you: ${reason}]`,
  });
  if (!file.url_private || file.mode === "tombstone" || file.file_access === "check_file_info") {
    return note("the app cannot read it");
  }
  if (MODEL_IMAGE_TYPES.has(mediaType)) {
    if ((file.size ?? 0) <= MAX_IMAGE_BYTES) {
      return { type: "file", mediaType, url: file.url_private, filename: name };
    }
    const thumb = file.thumb_1024 ?? file.thumb_960 ?? file.thumb_720 ?? file.thumb_480;
    return thumb
      ? { type: "file", mediaType: thumbMediaType(thumb, mediaType), url: thumb, filename: name }
      : note("it is too large");
  }
  if (mediaType === "application/pdf") {
    return (file.size ?? 0) <= MAX_DOCUMENT_BYTES
      ? { type: "file", mediaType, url: file.url_private, filename: name }
      : note("it is too large");
  }
  return note("the model cannot read this file type");
}

function thumbMediaType(url: string, fallback: string): string {
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return fallback;
}

const SLACK_FILE_HOST = "files.slack.com";
const SLACK_FILE_TIMEOUT_MS = 30_000;

/**
 * Download a Slack file URL with the bot token, for the model. Returns null for URLs that are not
 * Slack files (or, with `apiBaseUrl` overridden, not on that host). Slack answers a token without
 * `files:read` with its HTML sign-in page and a 200, so an HTML response is an error.
 */
function makeSlackDownload<TEvent>(api: SlackApi<TEvent>, apiBaseUrl: string) {
  const overrideOrigin = apiBaseUrl === SLACK_API_BASE_URL ? undefined : new URL(apiBaseUrl).origin;
  return async (
    url: URL,
    ctx: { handle?: SlackThreadHandle }
  ): Promise<ChannelDownloadedFile | null> => {
    const slackFile = url.protocol === "https:" && url.hostname === SLACK_FILE_HOST;
    if (!slackFile && url.origin !== overrideOrigin) return null;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${await api.token({ handle: ctx.handle })}` },
      signal: AbortSignal.timeout(SLACK_FILE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Slack file download failed: ${res.status}`);
    const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    if (mediaType === "text/html") {
      throw new Error(
        "Slack returned a sign-in page for the file: add the files:read scope to the bot token and reinstall the app"
      );
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_DOCUMENT_BYTES) throw new Error(`Slack file is too large (${length} bytes)`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error(`Slack file is too large (${data.byteLength} bytes)`);
    }
    return { data, ...(mediaType ? { mediaType } : {}) };
  };
}

type SlackEventWithContainer = SlackMessageEvent & {
  team_id?: string;
  team?: { id?: string };
  user?: { id?: string; team_id?: string };
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
  message?: { thread_ts?: string };
  channel?: { id?: string };
};

/**
 * The agent session an event belongs to, for `bind` and for posting: the thread (thread_ts is only
 * present on replies, so a thread-starting message binds to its own ts; a block_actions click
 * carries the thread on its container) and the user it came from, who is the stream recipient.
 */
export function slackThreadHandle(event: SlackEventWithContainer): SlackThreadHandle | null {
  const channel = event.event?.channel ?? event.container?.channel_id ?? event.channel?.id;
  const threadTs =
    event.event?.thread_ts ??
    event.event?.ts ??
    event.container?.thread_ts ??
    event.message?.thread_ts ??
    event.container?.message_ts;
  if (!channel || !threadTs) return null;
  const teamId = event.team_id ?? event.team?.id;
  const userId = event.event?.user ?? event.user?.id;
  const userTeamId = event.event?.user_team ?? event.user?.team_id;
  return {
    ...(teamId ? { teamId } : {}),
    channel,
    threadTs,
    ...(userId ? { userId } : {}),
    ...(userTeamId && userTeamId !== teamId ? { userTeamId } : {}),
  };
}

/** The thread a turn posts into: the event's when a Slack event started it, else the binding's. */
function threadFor(ctx: { event?: unknown; handle?: SlackThreadHandle }): SlackThreadHandle | null {
  const fromEvent = ctx.event ? slackThreadHandle(ctx.event as SlackEventWithContainer) : null;
  if (!fromEvent) return ctx.handle ?? null;
  if (fromEvent.userId || !ctx.handle?.userId) return fromEvent;
  return {
    ...fromEvent,
    userId: ctx.handle.userId,
    ...(ctx.handle.userTeamId ? { userTeamId: ctx.handle.userTeamId } : {}),
  };
}

/** Slack caps a section block's mrkdwn text at 3000 characters; stay under it with room for escaping. */
const SLACK_SECTION_MAX = 2900;
/** The smallest section toSlackBlocks accepts: room for a fence line, its closer and some text. */
const SLACK_SECTION_MIN = 64;

/**
 * Split markdown into Slack `section` blocks that each stay under the 3000-character mrkdwn limit,
 * converting to mrkdwn on the way. Splits happen at paragraph boundaries and never inside a fenced
 * code block: a fence that would straddle two sections is closed at the end of one and reopened at
 * the start of the next, so each block renders on its own. A single paragraph longer than the limit
 * is split on line breaks, then hard-split as a last resort.
 *
 * Use it from a custom `outbound` when you want Block Kit output (a header, the answer, a context
 * footer) without hand-rolling the size rules:
 *
 * @example
 * ```ts
 * outbound: (reply) =>
 *   reply.text ? { text: reply.text, blocks: [header, ...toSlackBlocks(reply.text), footer] } : null
 * ```
 */
export function toSlackBlocks(
  markdown: string,
  options: { maxChars?: number } = {}
): Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> {
  const requested = options.maxChars ?? SLACK_SECTION_MAX;
  if (!Number.isInteger(requested) || requested < SLACK_SECTION_MIN) {
    throw new RangeError(
      `toSlackBlocks: maxChars must be an integer of at least ${SLACK_SECTION_MIN}, got ${String(requested)}`
    );
  }
  const max = Math.min(requested, 3000);
  const mrkdwn = toSlackMrkdwn(markdown);
  const paragraphs = splitMrkdwnParagraphs(mrkdwn);
  const sections: string[] = [];
  let current = "";
  let openFence: string | null = null; // the fence line (```lang) that is open at the end of `current`

  const flush = () => {
    if (!current.trim()) return;
    sections.push(openFence ? `${current}\n\`\`\`` : current);
    current = openFence ? `${openFence}\n` : "";
  };

  for (const para of paragraphs) {
    const pieces = para.length > max ? hardSplit(para, max) : [para];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      const closer = openFence ? 4 : 0; // room for a closing fence if we must cut inside one
      if (candidate.length + closer > max && current) {
        flush();
      }
      current = current ? `${current}\n\n${piece}` : piece;
      openFence = fenceStateAfter(openFence, piece);
    }
  }
  if (current.trim()) sections.push(current);
  return sections.map((text) => ({
    type: "section" as const,
    text: { type: "mrkdwn" as const, text },
  }));
}

/** Paragraphs split on blank lines, except inside a fenced code block, which stays one paragraph. */
function splitMrkdwnParagraphs(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const lines = text.split("\n");
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (buf.length) out.push(buf.join("\n"));
      buf = [];
      continue;
    }
    buf.push(line);
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

/** The open fence line after appending `piece`, or null when balanced. */
function fenceStateAfter(open: string | null, piece: string): string | null {
  let state = open;
  for (const line of piece.split("\n")) {
    const m = /^\s*(```[^\n]*)/.exec(line);
    if (!m) continue;
    state = state ? null : m[1]!.trim();
  }
  return state;
}

/**
 * Split an oversized paragraph on line breaks, then by length, keeping fences balanced per part. A
 * line longer than a part is cut into chunks sized for the fence it sits in, so every emitted part
 * that is inside a code block still opens with the fence line and closes with a fence.
 */
function hardSplit(para: string, max: number): string[] {
  const parts: string[] = [];
  let current = "";
  let openFence: string | null = null;
  for (const line of para.split("\n")) {
    const fenceOverhead = openFence ? openFence.length + 1 + 4 : 0;
    const chunkSize = Math.max(1, max - fenceOverhead);
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += chunkSize) chunks.push(line.slice(i, i + chunkSize));
    if (chunks.length === 0) chunks.push("");
    for (const chunk of chunks) {
      const candidate = current ? `${current}\n${chunk}` : chunk;
      if (candidate.length + (openFence ? 4 : 0) > max && current) {
        parts.push(openFence ? `${current}\n\`\`\`` : current);
        current = openFence ? `${openFence}\n${chunk}` : chunk;
      } else {
        current = candidate;
      }
    }
    openFence = fenceStateAfter(openFence, line);
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Convert common GitHub-flavored markdown (what a model emits) to Slack mrkdwn, for Block Kit text in
 * a custom `outbound`: `**bold**` -> `*bold*`, `#` headings -> bold, `-`/`*` bullets -> `•`,
 * `[t](url)` -> `<url|t>`, `~~s~~` -> `~s~`. Replies the connector streams or posts itself are sent
 * as markdown and need no conversion. Fenced code blocks and inline code spans are passed through
 * verbatim, so a diff or a snippet containing `**`, `__`, `- ` or link syntax is not rewritten.
 * Single-asterisk `*italic*` is left as-is, so it renders bold in Slack (rare in model output).
 */
export function toSlackMrkdwn(md: string): string {
  const code: string[] = [];
  const masked = md.replace(/```[^\n]*\n[\s\S]*?(?:\n[ \t]*```|$)|`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  return convertMrkdwnProse(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]!);
}

function convertMrkdwnProse(md: string): string {
  return md
    .replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]{1,2000})\)/g, "<$2|$1>")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
}

function defaultSlackOutbound(reply: ChannelReply): ChannelMessage | null {
  return reply.text ? { text: reply.text } : null;
}

/**
 * Post a message into the turn's thread. A plain message goes as `markdown_text`, so the model's
 * markdown renders as written; a message with `blocks` posts them with `text` as the fallback.
 */
function makeSlackSend<TEvent>(api: SlackApi<TEvent>) {
  return async (
    message: ChannelMessage,
    ctx: ChannelSendCtx<TEvent, SlackThreadHandle>
  ): Promise<{ ref?: string }> => {
    const handle = threadFor(ctx);
    if (!handle) {
      throw new Error("slack send: no thread to post into (no event and no session binding)");
    }
    const blocks = (message as { blocks?: unknown }).blocks;
    const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
    const result = await api.call(
      "chat.postMessage",
      {
        channel: handle.channel,
        thread_ts: handle.threadTs,
        ...(hasBlocks ? { text: message.text, blocks } : { markdown_text: message.text }),
      },
      ctx
    );
    if (!result.ok) {
      // not_in_channel / channel_not_found is the common one: the bot isn't in the channel. Surface it.
      throw new Error(`slack chat.postMessage failed: ${result.error}`);
    }
    return { ref: result.ts };
  };
}

const SLACK_SESSION_STATUS: Record<ChannelLifecycleState, string> = {
  working: "processing",
  waiting: "suspended",
  idle: "active",
  closed: "closed",
};

/**
 * Mirror the session's lifecycle into the Slack agent session with `agents.sessions.setStatus`:
 * processing while a turn runs, suspended on an approval, active between turns, closed when the
 * conversation is closed. The first turn's call creates the session and carries its title.
 */
function makeSlackLifecycle<TEvent>(
  api: SlackApi<TEvent>,
  title: (prompt: string, event: TEvent | undefined) => string | null
) {
  return async (
    state: ChannelLifecycleState,
    ctx: ChannelLifecycleCtx<TEvent, SlackThreadHandle>
  ): Promise<void> => {
    const handle = threadFor(ctx);
    if (!handle) return;
    const sessionTitle =
      state === "working" && ctx.firstTurn && ctx.prompt ? title(ctx.prompt, ctx.event) : null;
    const result = await api.call(
      "agents.sessions.setStatus",
      {
        channel_id: handle.channel,
        thread_ts: handle.threadTs,
        status: SLACK_SESSION_STATUS[state],
        ...(sessionTitle ? { title: sessionTitle.slice(0, SLACK_TITLE_MAX) } : {}),
      },
      ctx
    );
    if (!result.ok) throw new Error(`slack agents.sessions.setStatus failed: ${result.error}`);
  };
}

/**
 * A stop during an approval: rewrite each controls message without its buttons, keeping what was
 * being approved, so nothing can be clicked after the session was stopped.
 */
function makeSlackCancelInteraction<TEvent>(
  api: SlackApi<TEvent>,
  render: (pending: ChannelPendingToolCall[]) => ChannelMessage | null
) {
  return async (
    cancelled: ChannelCancelledToolCall[],
    ctx: ChannelTurnCtx<TEvent, SlackThreadHandle>
  ): Promise<void> => {
    const handle = threadFor(ctx);
    if (!handle) return;
    const byRef = new Map<string, ChannelPendingToolCall[]>();
    for (const call of cancelled) {
      if (!call.ref) continue;
      byRef.set(call.ref, [...(byRef.get(call.ref) ?? []), call]);
    }
    const failures: string[] = [];
    for (const [ref, calls] of byRef) {
      const rendered = render(calls);
      const blocks = [
        ...((rendered?.blocks as Array<{ type?: string }> | undefined) ?? []).filter(
          (block) => block.type !== "actions"
        ),
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: ":no_entry_sign: *Stopped* before a decision" }],
        },
      ];
      const result = await api.call(
        "chat.update",
        { channel: handle.channel, ts: ref, text: "Stopped before a decision", blocks },
        ctx
      );
      if (!result.ok) failures.push(`${ref}: ${result.error}`);
    }
    if (failures.length > 0) {
      throw new Error(`slack chat.update failed for ${failures.join(", ")}`);
    }
  };
}

/** Wait before the first append, so the stream opens with more than a word. */
const STREAM_FIRST_FLUSH_MS = 250;
/** One append per stream per second keeps several concurrent streams inside Slack's per-method tier. */
const STREAM_FLUSH_MS = 1000;
/** Text per request, well under the 12,000 characters a request accepts. */
const STREAM_MAX_TEXT = 4000;
const STREAM_REQUEST_TIMEOUT_MS = 15_000;
/** How long `end()` keeps waiting out rate limits before the rest of the reply is posted instead. */
const STREAM_END_DEADLINE_MS = 30_000;
const STREAM_MAX_RETRY_AFTER_MS = 30_000;
const STREAM_MAX_RATE_LIMIT_RETRIES = 5;
/** Every Web API call gives up after this long, so a hung request never holds up a turn. */
const SLACK_REQUEST_TIMEOUT_MS = 15_000;
/** Slack caps a task card's text fields at 256 characters. */
const TASK_TEXT_MAX = 256;
/** The plan block's title while the turn's tools run; it changes to Done, Stopped and so on at the end. */
const PLAN_WORKING_TITLE = "Working on it";

type SlackStreamChunk =
  | { type: "markdown_text"; text: string }
  | { type: "plan_update"; title: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "complete" | "error";
      details?: string;
    };

/**
 * Native streaming: each turn opens a Slack stream in the thread with `chat.startStream`, appends the
 * reply's markdown (and tool calls as task cards) in batches with `chat.appendStream`, and closes it
 * with `chat.stopStream` when the turn ends. See {@link openSlackReplyStream} for failure handling.
 */
function makeSlackStream<TEvent>(
  api: SlackApi<TEvent>,
  options: { progress: "plan" | "tasks" | "off" }
) {
  return (ctx: ChannelStreamCtx<TEvent, SlackThreadHandle>): ChannelReplyStream | null => {
    const handle = threadFor(ctx);
    if (!handle) return null;
    return openSlackReplyStream(api, handle, ctx, options.progress);
  };
}

/** A tool's name as a task title: `searchArchive`, `search_archive` and `search-archive` all read "Search archive". */
export function readableToolName(toolName: string): string {
  const words = toolName
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((word) => (/^[A-Z0-9]+$/.test(word) && word.length > 1 ? word : word.toLowerCase()));
  const sentence = words.join(" ");
  return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : toolName;
}

/**
 * The worker that was streaming a reply died before it could close the stream. Close it with a note,
 * so the thread does not show the agent still writing; the recovered turn answers in a new stream.
 */
function makeSlackEndInterruptedStream<TEvent>(api: SlackApi<TEvent>) {
  return async (ref: string, ctx: ChannelTurnCtx<TEvent, SlackThreadHandle>): Promise<void> => {
    const handle = threadFor(ctx);
    if (!handle) return;
    const result = await api.call(
      "chat.stopStream",
      {
        channel: handle.channel,
        ts: ref,
        chunks: [{ type: "markdown_text", text: "\n\n_Interrupted. Picking this back up below._" }],
      },
      ctx
    );
    if (
      !result.ok &&
      result.error !== "message_not_in_streaming_state" &&
      result.error !== "message_not_found"
    ) {
      throw new Error(`slack chat.stopStream failed: ${result.error}`);
    }
  };
}

/**
 * One turn's Slack stream. Text is batched and appended at most once a second; a rate limit waits out
 * `Retry-After` and resends the same batch, since a rate-limited request was not applied.
 *
 * - A refused `chat.startStream` streams nothing, and `end()` reports the reply undelivered so the
 *   runtime posts it as a message instead.
 * - A request whose outcome is unknown (a timeout, a dropped connection, a 5xx) is never retried,
 *   because it may have been applied and a retry would repeat text. Nothing more is appended; at the
 *   end the stream is stopped and the text from that batch on is posted as its own message, so the
 *   reply is complete, at the cost of possibly repeating one batch.
 * - A stream the user already ended with Slack's stop button refuses appends with `stopped_by_user`;
 *   the rest of the turn's text is dropped, as the user asked.
 */
function openSlackReplyStream<TEvent>(
  api: SlackApi<TEvent>,
  handle: SlackThreadHandle,
  ctx: ChannelStreamCtx<TEvent, SlackThreadHandle>,
  progressMode: "plan" | "tasks" | "off"
): ChannelReplyStream {
  const tasks = progressMode !== "off";
  const plan = progressMode === "plan";
  let ts: string | undefined;
  let text = "";
  let sent = 0;
  let queuedTasks: SlackStreamChunk[] = [];
  let planOpened = false;
  const openTasks = new Map<string, string>();
  let state: "open" | "refused" | "stopped" | "unknown" = "open";
  let unknownFrom = 0;
  let ended = false;
  let endDeadline = Number.POSITIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const hasWork = () => state === "open" && (sent < text.length || queuedTasks.length > 0);

  const outcomeUnknown = () => {
    if (!ts) {
      state = "refused";
      return;
    }
    unknownFrom = sent;
    state = "unknown";
  };

  const sendBatch = async () => {
    const upTo = Math.min(text.length, sent + STREAM_MAX_TEXT);
    const batchText = text.slice(sent, upTo);
    const taskChunks = queuedTasks;
    queuedTasks = [];
    const openPlan = plan && !planOpened && taskChunks.length > 0;
    if (openPlan) planOpened = true;
    const chunks: SlackStreamChunk[] = [
      ...(openPlan ? [{ type: "plan_update" as const, title: PLAN_WORKING_TITLE }] : []),
      ...taskChunks,
      ...(batchText ? [{ type: "markdown_text" as const, text: batchText }] : []),
    ];
    if (chunks.length === 0) return;
    const method = ts ? "chat.appendStream" : "chat.startStream";
    const body = ts
      ? { channel: handle.channel, ts, chunks }
      : {
          channel: handle.channel,
          thread_ts: handle.threadTs,
          chunks,
          task_display_mode: plan ? "plan" : "timeline",
          ...(handle.userId ? { recipient_user_id: handle.userId } : {}),
          ...(handle.userTeamId || handle.teamId
            ? { recipient_team_id: handle.userTeamId ?? handle.teamId }
            : {}),
        };
    for (let attempt = 0; ; attempt++) {
      let result: SlackCall;
      try {
        result = await api.request(method, body, ctx, STREAM_REQUEST_TIMEOUT_MS);
      } catch (error) {
        logger.warn(`slack: ${method} outcome unknown; not retrying it`, { error });
        outcomeUnknown();
        return;
      }
      if (result.status === 429 || result.body.error === "ratelimited") {
        const wait = Math.min(result.retryAfterMs ?? 1000, STREAM_MAX_RETRY_AFTER_MS);
        if (ts && Date.now() + wait >= endDeadline) {
          logger.warn(
            `slack: ${method} still rate limited at the end of the turn; posting the rest`
          );
          unknownFrom = sent;
          state = "unknown";
          return;
        }
        if (attempt >= STREAM_MAX_RATE_LIMIT_RETRIES) {
          queuedTasks = [...taskChunks, ...queuedTasks];
          if (ended && !ts) state = "refused";
          return;
        }
        await sleep(wait);
        continue;
      }
      if (result.status >= 500) {
        logger.warn(`slack: ${method} failed with HTTP ${result.status}; not retrying it`);
        outcomeUnknown();
        return;
      }
      if (result.body.ok) {
        if (!ts && result.body.ts) {
          ts = result.body.ts;
          ctx.opened(ts);
        }
        sent = upTo;
        return;
      }
      const error = result.body.error;
      if (error === "stopped_by_user" || error === "message_not_in_streaming_state") {
        state = "stopped";
        return;
      }
      logger.warn(`slack: ${method} failed: ${error}`);
      if (!ts) {
        state = "refused";
      } else {
        unknownFrom = sent;
        state = "unknown";
      }
      return;
    }
  };

  const pump = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (hasWork()) await sendBatch();
    })().finally(() => {
      inFlight = undefined;
      if (!ended && hasWork()) arm(STREAM_FLUSH_MS);
    });
    return inFlight;
  };

  const arm = (ms: number) => {
    if (timer || ended || inFlight) return;
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, ms);
  };

  const task = (
    toolCallId: string,
    title: string,
    status: "pending" | "in_progress" | "complete" | "error"
  ) =>
    ({
      type: "task_update",
      id: toolCallId,
      title: title.slice(0, TASK_TEXT_MAX),
      status,
    }) as const;

  return {
    text(delta: string) {
      if (ended || !delta) return;
      text += delta;
      arm(ts ? STREAM_FLUSH_MS : STREAM_FIRST_FLUSH_MS);
    },
    progress(event: ChannelProgressEvent) {
      if (ended || !tasks) return;
      const title = event.title ?? readableToolName(event.toolName);
      if (event.type === "tool-call") {
        openTasks.set(event.toolCallId, title);
        queuedTasks.push(task(event.toolCallId, title, "in_progress"));
      } else if (event.type === "tool-result") {
        openTasks.delete(event.toolCallId);
        queuedTasks.push(task(event.toolCallId, title, "complete"));
      } else {
        openTasks.delete(event.toolCallId);
        queuedTasks.push({
          ...task(event.toolCallId, title, "error"),
          details: event.errorText.slice(0, TASK_TEXT_MAX),
        });
      }
      arm(ts ? STREAM_FLUSH_MS : STREAM_FIRST_FLUSH_MS);
    },
    async end(outcome: ChannelReplyStreamEnd): Promise<{ delivered: boolean }> {
      ended = true;
      endDeadline = Date.now() + STREAM_END_DEADLINE_MS;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
      while (hasWork()) await sendBatch();

      if (ts && state !== "stopped") {
        const closing: SlackStreamChunk[] = [];
        if (outcome.stopped || outcome.errorText) {
          for (const [toolCallId, title] of openTasks) {
            closing.push({
              ...task(toolCallId, title, "error"),
              ...(outcome.stopped ? { details: "Stopped" } : {}),
            });
          }
        } else if (outcome.pending) {
          for (const [toolCallId, title] of openTasks) {
            closing.push({
              ...task(toolCallId, title, "pending"),
              details: "Waiting for approval",
            });
          }
        }
        if (planOpened) {
          closing.push({
            type: "plan_update",
            title: outcome.stopped
              ? "Stopped"
              : outcome.errorText
                ? "Something went wrong"
                : outcome.pending
                  ? "Waiting for approval"
                  : "Done",
          });
        }
        if (outcome.errorText && state === "open") {
          closing.push({ type: "markdown_text", text: `\n\n_${outcome.errorText}_` });
        }
        try {
          const result = await api.request(
            "chat.stopStream",
            { channel: handle.channel, ts, ...(closing.length > 0 ? { chunks: closing } : {}) },
            ctx,
            STREAM_REQUEST_TIMEOUT_MS
          );
          if (!result.body.ok && result.body.error !== "message_not_in_streaming_state") {
            logger.warn(`slack: chat.stopStream failed: ${result.body.error}`);
          }
        } catch (error) {
          logger.warn("slack: chat.stopStream failed", { error });
        }
      }

      let tailDelivered = true;
      if (state === "unknown" && text.length > unknownFrom) {
        tailDelivered = false;
        try {
          const tail = text.slice(unknownFrom);
          const result = await api.call(
            "chat.postMessage",
            { channel: handle.channel, thread_ts: handle.threadTs, markdown_text: tail },
            ctx
          );
          if (result.ok) tailDelivered = true;
          else logger.warn(`slack: posting the rest of the reply failed: ${result.error}`);
        } catch (error) {
          logger.warn("slack: posting the rest of the reply failed", { error });
        }
      }
      return { delivered: ts !== undefined && tailDelivered };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replies requested per page: Slack's recommended cursor page size, independent of how many are kept. */
const SEED_PAGE_SIZE = 200;

/**
 * Seed a new thread session from the thread's existing replies. Skips the triggering message itself
 * and interactivity payloads. The bot's own posts (matched on the authorized bot user id) become
 * assistant messages; everyone else's become user messages attributed to the Slack user.
 *
 * Slack returns a thread oldest-first and pages it with a cursor, so the newest `limit` replies of a
 * long thread sit on the last page: the cursor is followed until Slack stops returning one, and the
 * tail is kept. A rate limit (HTTP 429) ends the walk with what was fetched so far rather than failing
 * the session: Slack's restricted tier for new non-Marketplace apps allows one `conversations.replies`
 * call per minute and 15 results, so such apps seed at most the first 15 replies.
 */
/** The seed cap: a non-negative integer, default 50. Zero seeds nothing. */
function seedLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(
      `slack: seedFromThread.limit must be a non-negative integer, got ${String(limit)}`
    );
  }
  return limit;
}

function makeSlackSeed<TEvent>(token: SlackToken<TEvent>, apiBaseUrl: string, limit: number) {
  return async (event: TEvent): Promise<ChannelSeedMessage[]> => {
    const e = event as unknown as SlackEventWithContainer & {
      authorizations?: Array<{ user_id?: string }>;
    };
    if (limit === 0) return [];
    if (e.type !== "event_callback" || !e.event) return [];
    const handle = slackThreadHandle(e);
    if (!handle) return [];
    const botUserId = e.authorizations?.[0]?.user_id;
    const botToken = typeof token === "function" ? await token(event) : token;
    type SlackReply = {
      ts?: string;
      text?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      files?: SlackFile[];
    };
    const messages: SlackReply[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        channel: handle.channel,
        ts: handle.threadTs,
        limit: String(SEED_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      const res = await fetch(`${apiBaseUrl}/conversations.replies?${params}`, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackReply[];
        response_metadata?: { next_cursor?: string };
      };
      if (res.status === 429 || body.error === "ratelimited") break;
      if (!body.ok) throw new Error(`slack conversations.replies failed: ${body.error}`);
      messages.push(...(body.messages ?? []));
      cursor = body.response_metadata?.next_cursor || undefined;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    const triggeringTs = e.event.ts;
    const withFileNotes = (m: SlackReply) =>
      [
        m.text ?? "",
        ...(m.files ?? []).map((f) => `[Attached file "${f.name || f.title || "file"}"]`),
      ]
        .filter(Boolean)
        .join("\n");
    const prior = messages
      .map((m) => ({ ...m, text: withFileNotes(m) }))
      .filter((m) => m.ts !== triggeringTs && m.text.length > 0)
      .filter(
        (m) =>
          !m.subtype ||
          m.subtype === "thread_broadcast" ||
          m.subtype === "bot_message" ||
          m.subtype === "file_share"
      )
      .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    return prior.slice(-limit).map((m) => {
      const fromBot = !!m.bot_id && (!botUserId || m.user === botUserId);
      return {
        role: fromBot ? ("assistant" as const) : ("user" as const),
        text: fromBot ? m.text! : `<@${m.user ?? "unknown"}>: ${m.text}`,
        externalMessageId: m.ts,
        externalUserId: m.user,
      };
    });
  };
}

function isAuthError(error: string | undefined): boolean {
  return error === "invalid_auth" || error === "token_revoked" || error === "account_inactive";
}

// Add/remove an emoji reaction on the triggering Slack message (needs the reactions:write scope).
function makeSlackReact<TEvent>(api: SlackApi<TEvent>) {
  return async (reaction: ChannelReaction, ctx: ChannelReactCtx<TEvent>): Promise<void> => {
    const event = ctx.event as SlackMessageEvent;
    const channel = event.event?.channel;
    const timestamp = event.event?.ts;
    const name = reaction.name.replace(/^:|:$/g, "");
    if (!channel || !timestamp || !name) return;
    const method = reaction.remove ? "reactions.remove" : "reactions.add";
    const result = await api.call(method, { channel, timestamp, name }, { event: ctx.event });
    // already_reacted / no_reaction are benign idempotent outcomes; surface anything else.
    if (!result.ok && result.error !== "already_reacted" && result.error !== "no_reaction") {
      throw new Error(`slack ${method} failed: ${result.error}`);
    }
  };
}

type SlackResponse = { ok: boolean; ts?: string; error?: string };
type SlackCall = { status: number; retryAfterMs?: number; body: SlackResponse };

/**
 * Web API calls with the bot token for a turn: resolved from the event, or, on a bound turn, from a
 * minimal event carrying the binding's team and thread, so a resolver keyed on `team_id` keeps
 * working. A resolver is asked again once on an auth error (token rotation).
 */
type SlackApi<TEvent> = {
  request(
    method: string,
    body: Record<string, unknown>,
    ctx: { event?: TEvent; handle?: SlackThreadHandle },
    timeoutMs?: number
  ): Promise<SlackCall>;
  call(
    method: string,
    body: Record<string, unknown>,
    ctx: { event?: TEvent; handle?: SlackThreadHandle }
  ): Promise<SlackResponse>;
  token(ctx: { event?: TEvent; handle?: SlackThreadHandle }): Promise<string>;
};

function makeSlackApi<TEvent>(token: SlackToken<TEvent>, baseUrl: string): SlackApi<TEvent> {
  const resolve = (ctx: { event?: TEvent; handle?: SlackThreadHandle }) => {
    if (typeof token !== "function") return token;
    const raw = ctx.event as { team_id?: string; team?: { id?: string } } | undefined;
    const event = raw
      ? ((raw.team_id === undefined && raw.team?.id
          ? { ...raw, team_id: raw.team.id }
          : raw) as TEvent)
      : ({
          team_id: ctx.handle?.teamId,
          event: { channel: ctx.handle?.channel, thread_ts: ctx.handle?.threadTs },
        } as TEvent);
    return token(event);
  };
  const request: SlackApi<TEvent>["request"] = async (method, body, ctx, timeoutMs) => {
    let result = await slackRequest(baseUrl, method, await resolve(ctx), body, timeoutMs);
    if (!result.body.ok && typeof token === "function" && isAuthError(result.body.error)) {
      result = await slackRequest(baseUrl, method, await resolve(ctx), body, timeoutMs);
    }
    return result;
  };
  return {
    request,
    call: async (method, body, ctx) =>
      (await request(method, body, ctx, SLACK_REQUEST_TIMEOUT_MS)).body,
    token: async (ctx) => resolve(ctx),
  };
}

async function slackRequest(
  baseUrl: string,
  method: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs?: number
): Promise<SlackCall> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const retryAfter = Number(res.headers.get("retry-after"));
  const parsed = (await res.json().catch(() => null)) as SlackResponse | null;
  if (!parsed && res.status < 500 && res.status !== 429) {
    throw new Error(`slack ${method}: unreadable response (HTTP ${res.status})`);
  }
  return {
    status: res.status,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    body: parsed ?? { ok: false, error: `http_${res.status}` },
  };
}

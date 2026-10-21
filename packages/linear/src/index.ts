import { createHash } from "node:crypto";
import { logger } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { jsonSchema, tool } from "ai";
import type {
  ChannelAckCtx,
  ChannelConnector,
  ChannelControl,
  ChannelDownloadedFile,
  ChannelErrorMessage,
  ChannelInbound,
  ChannelInteractionCtx,
  ChannelInteractionResolution,
  ChannelMessage,
  ChannelMessageInput,
  ChannelPendingToolCall,
  ChannelProgressEvent,
  ChannelReply,
  ChannelRunSurface,
  ChannelSeedMessage,
  ChannelSendCtx,
  ChannelTurnCtx,
} from "@trigger.dev/sdk/ai";
import type {
  ValidateWebhookFilter,
  WebhookEndpoint,
  WebhookHmacConfig,
  WebhookSource,
} from "@trigger.dev/core/v3";
import { webhookProviderConfigs } from "@trigger.dev/core/webhooks";

export type LinearUserRef = {
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
  url?: string;
};

export type LinearIssueRef = {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  teamId?: string;
};

export type LinearCommentRef = {
  id?: string;
  body?: string;
  userId?: string | null;
  createdAt?: string;
  user?: LinearUserRef | null;
};

export type LinearAgentActivityRef = {
  id: string;
  agentSessionId?: string;
  /** `{ type: "prompt", body }` for a user prompt. */
  content: { type?: string; body?: string; [key: string]: unknown };
  /** `"stop"` when the user asked the agent to halt. */
  signal?: string | null;
  signalMetadata?: Record<string, unknown> | null;
  sourceCommentId?: string | null;
  userId?: string | null;
  user?: LinearUserRef | null;
  createdAt?: string;
};

export type LinearAgentSessionRef = {
  id: string;
  status?: string;
  appUserId?: string;
  creatorId?: string | null;
  creator?: LinearUserRef | null;
  issueId?: string | null;
  issue?: LinearIssueRef | null;
  /** The thread comment the session lives under. Set on both mentions and delegations. */
  commentId?: string | null;
  comment?: LinearCommentRef | null;
  /** The comment that @mentioned the app. Null when the session came from a delegation. */
  sourceCommentId?: string | null;
  summary?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  url?: string | null;
};

/**
 * A minimal Linear `AgentSessionEvent` webhook envelope (Linear-API `AgentSessionEventWebhookPayload`).
 * Pass your own type for fuller typing.
 */
export type LinearAgentSessionEvent = {
  /** `"AgentSessionEvent"`; other Linear webhook types are filtered out server-side. */
  type: string;
  /** `"created"` (mention or delegation) or `"prompted"` (a new user message on the session). */
  action: string;
  createdAt?: string;
  organizationId?: string;
  oauthClientId?: string;
  appUserId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
  agentSession: LinearAgentSessionRef;
  /** The user's prompt on a `prompted` event. */
  agentActivity?: LinearAgentActivityRef | null;
  /** Linear's formatted issue context (identifier, title, description, labels, comments, ...). */
  promptContext?: string | null;
  /** Comments in the thread before the mention. */
  previousComments?: LinearCommentRef[] | null;
  /** Workspace or team guidance rules for agents. */
  guidance?: Array<{ body?: string; [key: string]: unknown }> | string | null;
};

/**
 * Linear signs `Linear-Signature: <hex>` as HMAC-SHA256 over the raw body, keyed by the webhook signing
 * secret from the OAuth app's webhook settings. Deliveries are deduplicated on the `Linear-Delivery`
 * header, which stays the same across Linear's retries (1 minute, 1 hour, 6 hours) while each retry
 * refreshes `webhookTimestamp` in the signed body. The header is not signed, so a captured request
 * replayed under a new header value within the replay window is processed again. The body's
 * `webhookTimestamp` (milliseconds) must be within a minute of now, as Linear recommends, which bounds
 * that window. This is the same config
 * `webhooks.linear()` uses, so both Linear surfaces verify identically.
 */
const LINEAR_VERIFIER: WebhookHmacConfig = webhookProviderConfigs.linear.config();

/** Only agent session events reach the connector; issue and comment webhooks on the same app do not. */
const AGENT_SESSION_GUARD = "event.type == 'AgentSessionEvent'";

/** One session per Linear agent session. */
const DEFAULT_KEY = "{event.agentSession.id}";

const LINEAR_SETUP_PROMPT = [
  "These settings live on the Linear OAuth application (Settings > API > OAuth applications). Tell the user each step unless you can change the application yourself.",
  "1. Open the application, turn on Webhooks and set the Webhook URL to the endpoint URL.",
  '2. Under the webhook categories, select "Agent session events". Save. Linear shows the webhook signing secret there.',
  "3. The app must be installed with actor=app and the app:assignable and app:mentionable scopes, so users can mention it and delegate issues to it.",
].join("\n");

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearToken<TEvent> = string | ((event: TEvent) => string | Promise<string>);

/**
 * The handle `linear()` binds a session to: enough to post activities into the agent session without
 * an inbound event. A turn that no Linear prompt started (a `chat.event` action that returns
 * `chat.turn()`) answers into this session.
 */
export type LinearSessionHandle = {
  agentSessionId: string;
  organizationId?: string;
  issueId?: string;
  issueIdentifier?: string;
};

/** The Linear agent activity types a connector can post. `prompt` is user-only. */
export type LinearActivityType = "thought" | "action" | "elicitation" | "response" | "error";

/**
 * How a channel message posts into Linear. The default outbound maps a final reply to a `response`,
 * an error to an `error`, and a non-final stream update to an ephemeral `thought`. A custom `outbound`
 * or `ack` can set this explicitly.
 */
export type LinearActivitySpec = {
  type: LinearActivityType;
  /** Only for `thought` and `action`: shown until the next activity arrives. */
  ephemeral?: boolean;
  /** `action` only. */
  action?: string;
  parameter?: string;
  result?: string;
  /** `elicitation` only. */
  signal?: "select" | "auth";
  signalMetadata?: Record<string, unknown>;
  /** Client-supplied UUID v4 for idempotent creation across run retries. */
  id?: string;
};

/** One step of the plan Linear shows on the session. The whole plan is replaced on every update. */
export type LinearPlanStep = {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
};

/**
 * What `run({ channel })` carries on a Linear turn: the connector's helpers over the agent session,
 * plus `react`/`unreact` (no-ops on Linear). Cast the `channel` argument to this type.
 */
export type LinearRunSurface = ChannelRunSurface<{
  /** Replace the session's plan. Linear renders it as a checklist that updates in place. */
  plan: (steps: LinearPlanStep[]) => Promise<void>;
  /** Post a thought. Ephemeral thoughts disappear when the next activity arrives. */
  thought: (text: string, options?: { ephemeral?: boolean }) => Promise<void>;
  /** Post an action ("Searching docs", "auth timeout"), optionally with its result. */
  action: (action: string, parameter: string, result?: string) => Promise<void>;
  /** Add a labelled external link to the session header. */
  link: (label: string, url: string) => Promise<void>;
  /**
   * Set the session's one-line summary from the first usable line of `text` (markdown markers and
   * control characters stripped, capped at 255 characters). Text with no usable line sets nothing.
   */
  summary: (text: string) => Promise<void>;
  /** The bound agent session and issue. */
  session: LinearSessionHandle;
}>;

/** The name of the tool {@link linearPlanTool} defines; the progress mirror skips it. */
export const LINEAR_PLAN_TOOL_NAME = "updatePlan";

/**
 * A tool the model calls to set and update its plan for the issue. Add it to the agent's `tools`
 * and ask for a plan in the system prompt; Linear renders it as a checklist that updates in place.
 * The whole list is replaced on every call. On a turn that is not a Linear session the tool
 * reports that nothing was updated, so the same agent can serve other surfaces unchanged.
 */
export function linearPlanTool() {
  return tool({
    description:
      "Set or update your plan for this issue as a short checklist. Replace the whole list each time: " +
      "mark finished steps completed, the current one inProgress, the rest pending. Call it when you " +
      "start and whenever a step changes state.",
    inputSchema: jsonSchema<{ steps: LinearPlanStep[] }>({
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "One step, a few words" },
              status: { type: "string", enum: ["pending", "inProgress", "completed", "canceled"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    }),
    execute: async ({ steps }) => {
      const surface = chat.surface<LinearRunSurface>();
      if (!surface?.plan) {
        return { updated: false, reason: "not a Linear session" };
      }
      await surface.plan(steps);
      return { updated: true, steps: steps.length };
    },
  });
}

/** The channel message shape `linear()` posts: text plus how it becomes an activity. */
export type LinearChannelMessage = ChannelMessage & {
  activity?: LinearActivitySpec;
  /** Also set the session summary (1 to 255 characters) after posting. */
  summary?: string;
  /** Post several activities in order (used by HITL controls, one elicitation per pending tool). */
  activities?: Array<LinearActivitySpec & { text: string }>;
};

export type LinearChannelOptions<
  TEvent,
  TFilter extends string = string,
  TStartOn extends string = string,
> = {
  id: string;
  /** The endpoint to subscribe to, declared with `webhooks.endpoint.define({ id, source: webhookSource() })`. */
  endpoint: WebhookEndpoint<TEvent>;
  /**
   * OAuth access token for the workspace the app is installed in (`actor=app`), or a resolver keyed on
   * the event's `organizationId` for multi-workspace installs.
   */
  token: LinearToken<TEvent>;
  /**
   * Session key template over `{event.x}`, `{header.x}` and `{webhook.x}` placeholders. Defaults to one
   * session per Linear agent session.
   */
  key?: string;
  /** Map an event to the turn's message. Defaults to the framing described in the docs. */
  inbound?: (event: TEvent) => ChannelInbound;
  /** Map the agent's reply to an activity. Defaults to `response` (final), `error`, or ephemeral `thought`. */
  outbound?: (reply: ChannelReply) => LinearChannelMessage | null;
  /**
   * The first activity, posted as soon as the turn starts (Linear expects one within ten seconds of
   * `created`). Defaults to an ephemeral thought "Looking into this...". `null` posts nothing.
   */
  ack?: ((event: TEvent, ctx: ChannelAckCtx) => LinearChannelMessage | null) | null;
  /** Extra server-side filter, composed AND with the mandatory agent-session guard. */
  filter?: ValidateWebhookFilter<TEvent, TFilter>;
  /** Only start a NEW session when an event matches this filter; existing sessions always resume. */
  startOn?: ValidateWebhookFilter<TEvent, TStartOn>;
  /** "final" (default): ack then the response. "stream": debounced ephemeral thoughts while streaming. */
  delivery?: "final" | "stream";
  /**
   * Mirror the turn's tool calls into the session as `action` activities: the call as an ephemeral
   * action when its input is ready, then the same action with its `result` when the tool returns.
   * `"off"` posts nothing while the turn runs. Default `"actions"`.
   */
  progress?: "actions" | "off";
  /**
   * Set the session summary (its title in Linear) from the first line of each final reply. Off by
   * default: Linear generates a title from the conversation itself, and a reply's first line
   * overwrites it on every turn.
   */
  summarize?: boolean;
  /**
   * What from the payload is put in front of the model on the first turn. All default to true.
   * `guidance` and `promptContext` are prefixed into the triggering message; `previousComments` are
   * seeded as prior transcript messages.
   */
  context?: {
    guidance?: boolean;
    promptContext?: boolean;
    previousComments?: boolean;
  };
  /**
   * How a pending human-decision tool is described on the approval card, per tool name. Return the
   * card's markdown body (a title line is added when `title` is set); return null or omit a tool to
   * use the default, which renders the tool input as markdown (lists of items, key and value bullets)
   * and falls back to JSON for shapes it cannot lay out.
   */
  approvals?: Record<
    string,
    (input: unknown, call: ChannelPendingToolCall) => { title?: string; body: string } | null
  >;
  /**
   * Linear UI for tools with no `execute`, keyed by tool name: an elicitation card with a select of
   * `options`. The chosen option resolves the tool to `{ selected: option }`. A tool without an entry
   * gets the Approve and Deny card (see `approvals`).
   */
  interactions?: Record<
    string,
    (call: ChannelPendingToolCall) => { title?: string; body: string; options: string[] } | null
  >;
  /**
   * The thought posted as soon as a prompt arrives while the agent is still working. The prompt is
   * either folded into the work in progress (`pendingMessages` on the agent) or answered right
   * after, so the wording should be true either way. Default "Got it, I'll take that into
   * account."; a function of the event for wording per prompt; null posts nothing.
   */
  receivedThought?: string | null | ((event: TEvent) => string | null);
  /**
   * The error activity's text when a turn fails (a model or provider error), in place of the error.
   * A fixed line, or a function of the failure (`error`, `partialText`, `event`, `runId`, `chatId`)
   * that returns one. Defaults to "Something went wrong answering this. Try again." The error is
   * logged on the run.
   */
  errorMessage?: ChannelErrorMessage<TEvent>;
  /**
   * Override the Linear GraphQL URL (for testing against a mock). Files on this URL's origin are
   * also treated as Linear uploads.
   */
  apiUrl?: string;
};

/**
 * The Linear source for `webhooks.endpoint.define({ id, source: webhookSource() })`:
 * `Linear-Signature` HMAC verification, a one minute replay window on the body's
 * `webhookTimestamp`, dedup on the signed request (the same config as `webhooks.linear()`), and a
 * setup prompt. Paste the signing secret from the OAuth app's webhook settings as the endpoint
 * secret. Subscribe `webhook()` tasks to the endpoint, or pass it to `linear({ endpoint })` for an
 * agent frontend.
 */
export function webhookSource<TEvent = LinearAgentSessionEvent>(): WebhookSource<TEvent> {
  return {
    provider: "linear",
    verifier: { kind: "config", config: LINEAR_VERIFIER },
    secretProvisioning: "provider",
    setupPrompt: LINEAR_SETUP_PROMPT,
  };
}

/**
 * Linear agent sessions as a chat frontend for an agent. List on `chat.agent({ channels: [linear({...})] })`:
 * when a user mentions the app or delegates an issue to it, Linear opens an agent session, the connector
 * routes it to a durable session keyed on the agent session id, runs the prompt as a turn, and posts the
 * reply back as a `response` activity. Install the OAuth app with `actor=app`, request the
 * `app:assignable` and `app:mentionable` scopes, enable the "Agent session events" webhook category, and
 * set the endpoint's signing secret to the webhook signing secret.
 *
 * @example
 * ```ts
 * const linearEvents = webhooks.endpoint.define({ id: "linear", source: webhookSource() });
 * export const agent = chat.agent({
 *   id: "triage",
 *   channels: [linear({ id: "linear", endpoint: linearEvents, token: process.env.LINEAR_TOKEN! })],
 *   run: async ({ messages, streamText }) => streamText({ model, messages }),
 * });
 * ```
 */
export function linear<
  TEvent = LinearAgentSessionEvent,
  const TFilter extends string = string,
  const TStartOn extends string = string,
>(
  options: LinearChannelOptions<TEvent, TFilter, TStartOn>
): ChannelConnector<TEvent, LinearSessionHandle> {
  const apiUrl = options.apiUrl ?? LINEAR_GRAPHQL_URL;
  if (!options.endpoint?.id) {
    throw new Error(
      `linear("${options.id}"): an endpoint is required. Declare one with webhooks.endpoint.define({ id, source: webhookSource() }) and pass it as { endpoint }.`
    );
  }
  if (options.endpoint.source !== "linear") {
    throw new Error(
      `linear("${options.id}"): endpoint "${options.endpoint.id}" has source "${options.endpoint.source}". Declare it with webhooks.endpoint.define({ id, source: webhookSource() }) from @trigger.dev/linear.`
    );
  }
  const filter = options.filter
    ? `${AGENT_SESSION_GUARD} && (${options.filter})`
    : AGENT_SESSION_GUARD;
  const context = {
    guidance: options.context?.guidance ?? true,
    promptContext: options.context?.promptContext ?? true,
    previousComments: options.context?.previousComments ?? true,
  };
  const ack =
    options.ack === null
      ? undefined
      : (options.ack ??
        ((_event: TEvent, ctx: ChannelAckCtx): LinearChannelMessage => ({
          text: ctx.recovered ? "Picking this back up..." : "Looking into this...",
          activity: { type: "thought", ephemeral: true },
        })));
  const api = makeLinearApi(options.token, apiUrl);
  const uploadsOrigin = apiUrl === LINEAR_GRAPHQL_URL ? undefined : new URL(apiUrl).origin;
  const receivedThought =
    options.receivedThought === undefined ? DEFAULT_RECEIVED_THOUGHT : options.receivedThought;
  const summarize = options.summarize ?? false;
  const outbound = options.outbound ?? defaultLinearOutbound;

  return chat.channels.custom<WebhookEndpoint<TEvent>, string, string, string, LinearSessionHandle>(
    {
      id: options.id,
      endpoint: options.endpoint,
      key: options.key ?? DEFAULT_KEY,
      inbound:
        options.inbound ??
        ((event: TEvent) =>
          defaultLinearInbound(event as unknown as LinearAgentSessionEvent, {
            ...context,
            uploadsOrigin,
          })),
      bind: linearSessionHandle as (event: TEvent) => LinearSessionHandle | null,
      ...(context.previousComments
        ? {
            seed: (event: TEvent) =>
              seedFromPreviousComments(event as unknown as LinearAgentSessionEvent),
          }
        : {}),
      outbound: summarize ? withSummary(outbound) : outbound,
      ack,
      send: makeLinearSend(api),
      ...(options.progress === "off" ? {} : { progress: makeLinearProgress(api) }),
      surface: makeLinearSurface(api),
      renderInteraction: makeLinearRenderInteraction(options.approvals, options.interactions) as (
        pending: ChannelPendingToolCall[],
        ctx: ChannelInteractionCtx<TEvent>
      ) => ChannelMessage | null,
      onInteraction: defaultLinearOnInteraction as (
        event: TEvent
      ) => ChannelInteractionResolution | null,
      finalizeInteraction: makeLinearFinalizeInteraction(api),
      onControl: linearControl as (event: TEvent) => ChannelControl | null,
      download: makeLinearDownload(api, uploadsOrigin) as (
        url: URL,
        ctx: { handle?: LinearSessionHandle }
      ) => Promise<ChannelDownloadedFile | null>,
      ...(receivedThought === null
        ? {}
        : {
            received: async (ctx: ChannelTurnCtx<TEvent, LinearSessionHandle>) => {
              const text =
                typeof receivedThought === "function"
                  ? receivedThought(ctx.event as TEvent)
                  : receivedThought;
              if (!text) return;
              await api.activity(ctx, {
                type: "thought",
                text,
                id: linearActivityId("received", ctx.deliveryId),
              });
            },
          }),
      filter: filter as never,
      startOn: options.startOn as never,
      delivery: options.delivery ?? "final",
      errorMessage: options.errorMessage,
    }
  );
}

/** The agent session an event belongs to, for `bind` and for posting. */
export function linearSessionHandle(event: LinearAgentSessionEvent): LinearSessionHandle | null {
  const agentSessionId = event.agentSession?.id;
  if (!agentSessionId) return null;
  const issueId = event.agentSession.issueId ?? event.agentSession.issue?.id ?? undefined;
  const issueIdentifier = event.agentSession.issue?.identifier;
  return {
    agentSessionId,
    ...(event.organizationId ? { organizationId: event.organizationId } : {}),
    ...(issueId ? { issueId } : {}),
    ...(issueIdentifier ? { issueIdentifier } : {}),
  };
}

/**
 * True when the session came from an @mention in a comment. A delegation (the issue assigned to the
 * app) has no `sourceCommentId`; Linear still attaches a placeholder comment ("This thread is for an
 * agent session with ...") to it, so `comment` alone does not tell the two apart.
 */
export function isMention(event: LinearAgentSessionEvent): boolean {
  return !!event.agentSession?.sourceCommentId;
}

/**
 * A Stop pressed in Linear while a turn is running aborts that turn: the partial reply posts as the
 * response and the stop prompt is consumed. Pressed while idle, the same prompt runs as a turn and
 * `defaultLinearInbound` turns it into a wind-down instruction. The stop is dated with the
 * activity's `createdAt`, so one pressed while a turn ran but delivered after it ended is consumed
 * rather than run as a wind-down.
 */
export function linearControl(event: LinearAgentSessionEvent): ChannelControl | null {
  if (!isStopSignal(event)) return null;
  const pressedAt = Date.parse(event.agentActivity?.createdAt ?? "");
  return {
    kind: "stop",
    message: "stopped from Linear",
    ...(Number.isFinite(pressedAt) ? { at: pressedAt } : {}),
  };
}

/** True when the user asked the agent to halt (`prompted` with the `stop` signal). */
export function isStopSignal(event: LinearAgentSessionEvent): boolean {
  return event.action === "prompted" && event.agentActivity?.signal === "stop";
}

const STOP_MESSAGE =
  "The user asked you to stop. Do not take any further actions. Reply with a short summary of what you did and what is left.";

function userLabel(user?: LinearUserRef | null, userId?: string | null): string {
  const name = user?.displayName ?? user?.name;
  if (name && name.includes("@") && user?.url) {
    const handle = user.url.split("/").filter(Boolean).pop();
    if (handle) return handle;
  }
  return name ?? userId ?? "a user";
}

function guidanceText(guidance: LinearAgentSessionEvent["guidance"]): string {
  if (!guidance) return "";
  if (typeof guidance === "string") return guidance.trim();
  return guidance
    .map((rule) => (typeof rule?.body === "string" ? rule.body.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Default inbound: the user's prompt, framed so the model can tell Linear-supplied context from
 * instructions. `created` carries the issue context and the mention comment (or an assignment notice
 * when the session came from delegation); `prompted` carries just the new message. A `stop` signal
 * becomes an instruction to wind down.
 */
export function defaultLinearInbound(
  event: LinearAgentSessionEvent,
  context: { guidance: boolean; promptContext: boolean; uploadsOrigin?: string } = {
    guidance: true,
    promptContext: true,
  }
): ChannelInbound {
  const inbound = linearInboundText(event, context);
  const markdown =
    event.action === "prompted"
      ? isStopSignal(event)
        ? ""
        : (event.agentActivity?.content?.body ?? "")
      : [
          isMention(event) ? (event.agentSession?.comment?.body ?? "") : "",
          context.promptContext ? (event.promptContext ?? "") : "",
        ].join("\n");
  const files = linearFileParts(markdown, { uploadsOrigin: context.uploadsOrigin });
  if (files.length === 0) return inbound;
  return {
    ...inbound,
    message: {
      id: "",
      role: "user",
      parts: [{ type: "text", text: inbound.message as string }, ...files],
    } as ChannelMessageInput,
  };
}

function linearInboundText(
  event: LinearAgentSessionEvent,
  context: { guidance: boolean; promptContext: boolean }
): { message: string; externalUserId?: string; externalMessageId?: string } {
  const session = event.agentSession;
  const issue = session?.issue;
  const issueLabel = issue?.identifier
    ? `${issue.identifier}${issue.title ? ` "${issue.title}"` : ""}`
    : session?.issueId
      ? `issue ${session.issueId}`
      : "this issue";

  if (event.action === "prompted") {
    if (isStopSignal(event)) {
      return {
        message: STOP_MESSAGE,
        externalUserId: event.agentActivity?.userId ?? undefined,
        externalMessageId: event.agentActivity?.id,
      };
    }
    const body = event.agentActivity?.content?.body ?? "";
    return {
      message: body,
      externalUserId: event.agentActivity?.userId ?? undefined,
      externalMessageId: event.agentActivity?.id,
    };
  }

  const who = userLabel(session?.creator, session?.creatorId);
  const sections: string[] = [];
  const comment = isMention(event) ? session?.comment?.body?.trim() : undefined;
  sections.push(
    comment ? `${who} mentioned you on ${issueLabel}.` : `${who} assigned ${issueLabel} to you.`
  );
  const guidance = context.guidance ? guidanceText(event.guidance) : "";
  if (guidance) sections.push(`Workspace guidance:\n${guidance}`);
  if (context.promptContext && event.promptContext) {
    sections.push(`Issue context:\n${event.promptContext.trim()}`);
  }
  if (comment) sections.push(`${who}'s comment:\n${comment}`);

  return {
    message: sections.join("\n\n"),
    externalUserId: session?.creatorId ?? session?.comment?.userId ?? undefined,
    externalMessageId: session?.commentId ?? session?.id,
  };
}

const LINEAR_UPLOADS_HOST = "uploads.linear.app";
/** Most files taken from one message, so an issue with dozens of screenshots stays affordable. */
const MAX_LINEAR_FILES = 10;
const MAX_LINEAR_FILE_BYTES = 20 * 1024 * 1024;
const LINEAR_FILE_TIMEOUT_MS = 30_000;
const DEFAULT_RECEIVED_THOUGHT = "Got it, I'll take that into account.";

const LINEAR_IMAGE = /<linear-image\b[^>]*>([\s\S]*?)<\/linear-image>/g;

/** A file the model can read, from a Linear upload link in markdown. */
export type LinearFilePart = { type: "file"; mediaType: string; url: string; filename: string };

function isLinearUpload(url: URL, uploadsOrigin?: string): boolean {
  return (
    (url.protocol === "https:" && url.hostname === LINEAR_UPLOADS_HOST) ||
    url.origin === uploadsOrigin
  );
}

/**
 * Images and PDFs a Linear body links to on Linear's upload host, as file parts for the model: a
 * `<linear-image>` tag (how Linear embeds images in the issue context) or `![alt](url)` as an image,
 * and `[name.pdf](url)` as a PDF. A signed URL's short-lived `signature` is dropped; `linear()`
 * downloads the file with the app's token when the model reads it. The default `inbound` adds them
 * for the prompt, the mention comment and the issue context; use it in a custom `inbound` to keep
 * that. At most ten per message.
 */
export function linearFileParts(
  markdown: string | null | undefined,
  options: { uploadsOrigin?: string } = {}
): LinearFilePart[] {
  const text = markdown ?? "";
  const found: Array<{ index: number; href: string; name: string; image: boolean }> = [];
  for (const match of text.matchAll(LINEAR_IMAGE)) {
    try {
      const node = JSON.parse(match[1]!) as { attrs?: { src?: string; alt?: string } };
      if (node.attrs?.src) {
        found.push({
          index: match.index!,
          href: node.attrs.src,
          name: node.attrs.alt ?? "",
          image: true,
        });
      }
    } catch {
      continue;
    }
  }
  const outsideTags = text.replace(LINEAR_IMAGE, (tag) => " ".repeat(tag.length));
  for (const match of outsideTags.matchAll(/(!?)\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g)) {
    const [, bang, label, href] = match;
    const name = label?.trim() ?? "";
    if (bang || /\.pdf$/i.test(name)) {
      found.push({ index: match.index!, href: href!, name, image: !!bang });
    }
  }
  const parts: LinearFilePart[] = [];
  const seen = new Set<string>();
  for (const file of found.sort((a, b) => a.index - b.index)) {
    if (parts.length >= MAX_LINEAR_FILES) break;
    let url: URL;
    try {
      url = new URL(file.href);
    } catch {
      continue;
    }
    if (!isLinearUpload(url, options.uploadsOrigin)) continue;
    url.searchParams.delete("signature");
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    parts.push(
      file.image
        ? { type: "file", mediaType: "image/*", url: url.href, filename: file.name || "image" }
        : { type: "file", mediaType: "application/pdf", url: url.href, filename: file.name }
    );
  }
  return parts;
}

/**
 * Download a Linear upload with the app's token, for the model. Null for URLs that are not Linear
 * uploads (or, with `apiUrl` overridden, not on that origin).
 */
function makeLinearDownload<TEvent>(api: LinearApi<TEvent>, uploadsOrigin?: string) {
  return async (
    url: URL,
    ctx: { handle?: LinearSessionHandle }
  ): Promise<ChannelDownloadedFile | null> => {
    if (!isLinearUpload(url, uploadsOrigin)) return null;
    const token = await api.tokenFor({ handle: ctx.handle });
    const res = await fetch(url, {
      headers: { authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` },
      signal: AbortSignal.timeout(LINEAR_FILE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Linear file download failed: ${res.status}`);
    const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    if (mediaType === "text/html") {
      throw new Error("Linear returned a page instead of the file; check the app's token");
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_LINEAR_FILE_BYTES)
      throw new Error(`Linear file is too large (${length} bytes)`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_LINEAR_FILE_BYTES) {
      throw new Error(`Linear file is too large (${data.byteLength} bytes)`);
    }
    return { data, ...(mediaType ? { mediaType } : {}) };
  };
}

/** Prior comments from the payload become transcript messages ahead of the triggering one. */
export function seedFromPreviousComments(event: LinearAgentSessionEvent): ChannelSeedMessage[] {
  if (event.action !== "created") return [];
  const appUserId = event.appUserId ?? event.agentSession?.appUserId;
  return (event.previousComments ?? [])
    .filter((c) => typeof c?.body === "string" && c.body.trim().length > 0)
    .map((c) => {
      const fromApp = !!appUserId && c.userId === appUserId;
      return {
        role: fromApp ? ("assistant" as const) : ("user" as const),
        text: fromApp ? c.body!.trim() : `${userLabel(c.user, c.userId)}: ${c.body!.trim()}`,
        ...(c.id ? { externalMessageId: c.id } : {}),
        ...(c.userId ? { externalUserId: c.userId } : {}),
      };
    });
}

/**
 * A reply cut short by Stop: close a code fence the cut left open so the rest of the session renders,
 * and say it was stopped.
 */
export function stoppedMarkdown(text: string): string {
  const trimmed = toLinearMarkdown(text);
  const fences = (trimmed.match(/^\s*```/gm) ?? []).length;
  const closed = fences % 2 === 1 ? `${trimmed}\n\`\`\`` : trimmed;
  return `${closed}\n\n_Stopped._`;
}

/** Linear renders GitHub-flavored markdown and turns bare Linear URLs into mentions. Trims only. */
export function toLinearMarkdown(text: string): string {
  return text.replace(/\s+$/, "");
}

function defaultLinearOutbound(reply: ChannelReply): LinearChannelMessage | null {
  if (reply.error) {
    const text = reply.text?.trim() || "Something went wrong while working on this.";
    return { text, activity: { type: "error" } };
  }
  if (reply.stopped) {
    return {
      text: reply.text ? stoppedMarkdown(reply.text) : "_Stopped._",
      activity: { type: "response" },
    };
  }
  if (!reply.text) return null;
  if (!reply.final) {
    return {
      text: toLinearMarkdown(reply.text),
      activity: { type: "thought", ephemeral: true },
    };
  }
  if (reply.pending) {
    return { text: toLinearMarkdown(reply.text), activity: { type: "thought" } };
  }
  return { text: toLinearMarkdown(reply.text), activity: { type: "response" } };
}

type LinearApi<TEvent> = {
  handleFor: (ctx: { event?: TEvent; handle?: LinearSessionHandle }) => LinearSessionHandle;
  tokenFor: (ctx: { event?: TEvent; handle?: LinearSessionHandle }) => Promise<string>;
  activity: (
    ctx: { event?: TEvent; handle?: LinearSessionHandle },
    spec: LinearActivitySpec & { text: string }
  ) => Promise<{ id?: string }>;
  updateSession: (
    ctx: { event?: TEvent; handle?: LinearSessionHandle },
    input: Record<string, unknown>
  ) => Promise<void>;
};

/**
 * Resolves where to post and with which token. A channel-started turn posts into the event's agent
 * session; a bound turn (no event) posts into the session the handle names. A token resolver receives
 * the event when there is one and otherwise a minimal event carrying the bound organization, so a
 * resolver keyed on `organizationId` keeps working.
 */
function makeLinearApi<TEvent>(token: LinearToken<TEvent>, apiUrl: string): LinearApi<TEvent> {
  const handleFor: LinearApi<TEvent>["handleFor"] = (ctx) => {
    const fromEvent = ctx.event
      ? linearSessionHandle(ctx.event as unknown as LinearAgentSessionEvent)
      : null;
    const handle = fromEvent ?? ctx.handle;
    if (!handle) {
      throw new Error("linear: no agent session to post into (no event and no session binding)");
    }
    return handle;
  };
  const tokenFor: LinearApi<TEvent>["tokenFor"] = async (ctx) => {
    if (typeof token !== "function") return token;
    const handle = handleFor(ctx);
    const tokenEvent = (ctx.event ??
      ({
        type: "AgentSessionEvent",
        action: "bound",
        organizationId: handle.organizationId,
        agentSession: { id: handle.agentSessionId, issueId: handle.issueId },
      } as unknown)) as TEvent;
    return token(tokenEvent);
  };
  return {
    handleFor,
    tokenFor,
    activity: async (ctx, spec) =>
      createAgentActivity(apiUrl, await tokenFor(ctx), handleFor(ctx).agentSessionId, spec),
    updateSession: async (ctx, input) =>
      updateAgentSession(apiUrl, await tokenFor(ctx), handleFor(ctx).agentSessionId, input),
  };
}

/**
 * A stable, UUID-shaped id for one logical activity, derived from what identifies it (the session,
 * the delivery, the activity kind, its key and, for sends, its content), so a turn that retries after
 * Linear accepted the activity recreates the same one instead of a duplicate. Undefined when any part
 * is missing, which makes Linear assign an id and accept a duplicate: the case for a bound turn with
 * no delivery.
 */
function linearActivityId(...parts: Array<string | number | undefined>): string | undefined {
  if (parts.some((part) => part === undefined || part === "")) return undefined;
  const hex = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function makeLinearSend<TEvent>(api: LinearApi<TEvent>) {
  return async (
    message: ChannelMessage,
    ctx: ChannelSendCtx<TEvent, LinearSessionHandle>
  ): Promise<{ ref?: string }> => {
    const msg = message as LinearChannelMessage;
    const specs: Array<LinearActivitySpec & { text: string }> =
      msg.activities && msg.activities.length > 0
        ? msg.activities
        : [{ ...(msg.activity ?? { type: "response" as const }), text: msg.text }];
    const sessionId = api.handleFor(ctx).agentSessionId;

    let lastId: string | undefined;
    for (const [index, spec] of specs.entries()) {
      // Keyed on the content as well as the position: a retry of the same send derives the same id,
      // while the ack, each streamed snapshot, a final response and an error text on one delivery all
      // differ in text or type and so stay distinct activities.
      const id =
        spec.id ?? linearActivityId("send", sessionId, ctx.deliveryId, index, spec.type, spec.text);
      const result = await api.activity(ctx, id ? { ...spec, id } : spec);
      lastId = result.id ?? lastId;
    }
    if (msg.summary) {
      try {
        await api.updateSession(ctx, { summary: msg.summary });
      } catch (error) {
        logger.warn("linear: session summary update failed; the reply was posted without it", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ref: lastId };
  };
}

/** Wrap an outbound so a final response also sets the session summary from its first line. */
function withSummary(
  outbound: (reply: ChannelReply) => LinearChannelMessage | null
): (reply: ChannelReply) => LinearChannelMessage | null {
  return (reply) => {
    const msg = outbound(reply);
    if (
      !msg ||
      !reply.final ||
      reply.error ||
      msg.summary ||
      (msg.activity?.type ?? "response") !== "response"
    ) {
      return msg;
    }
    const summary = summaryLine(msg.text);
    return summary ? { ...msg, summary } : msg;
  };
}

/**
 * The first non-empty line of a reply, stripped of markdown markers and control characters, capped at
 * 255 characters: what Linear accepts as a session summary. Undefined when nothing usable is left.
 */
export function summaryLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) =>
      l
        .replace(/^[#>*\-\s]+/, "")
        .replace(/[*_`]/g, "")
        .replace(/\p{Cc}/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > 255 ? line.slice(0, 252) + "..." : line;
}

const MAX_ACTION_PARAMETER_CHARS = 500;
const MAX_ACTION_RESULT_CHARS = 1500;

function compact(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/**
 * Mirror tool calls into the session: an ephemeral `action` when the call's input is ready, then the
 * same action with its `result` (or the error) when the tool returns.
 */
function makeLinearProgress<TEvent>(api: LinearApi<TEvent>) {
  return async (
    event: ChannelProgressEvent,
    ctx: ChannelTurnCtx<TEvent, LinearSessionHandle>
  ): Promise<void> => {
    if (event.toolName === LINEAR_PLAN_TOOL_NAME) return;
    const id = linearActivityId(
      "progress",
      api.handleFor(ctx).agentSessionId,
      ctx.deliveryId,
      event.toolCallId,
      event.type
    );
    switch (event.type) {
      case "tool-call":
        await api.activity(ctx, {
          id,
          type: "action",
          text: event.toolName,
          action: event.toolName,
          parameter: compact(event.input ?? "", MAX_ACTION_PARAMETER_CHARS),
          ephemeral: true,
        });
        return;
      case "tool-result":
        await api.activity(ctx, {
          id,
          type: "action",
          text: event.toolName,
          action: event.toolName,
          parameter: "",
          result: compact(event.output ?? "", MAX_ACTION_RESULT_CHARS),
        });
        return;
      case "tool-error":
        await api.activity(ctx, {
          id,
          type: "action",
          text: event.toolName,
          action: event.toolName,
          parameter: "",
          result: `Error: ${compact(event.errorText, MAX_ACTION_RESULT_CHARS)}`,
        });
        return;
    }
  };
}

/**
 * The helpers `run({ channel })` gets on a Linear turn. See {@link LinearRunSurface}. Activities
 * posted from here carry no idempotency id: they are the run's own calls with no stable identity
 * the connector can derive, so a retried turn that calls them again posts them again.
 */
function makeLinearSurface<TEvent>(api: LinearApi<TEvent>) {
  return (ctx: ChannelTurnCtx<TEvent, LinearSessionHandle>): Record<string, unknown> => {
    const post = (spec: LinearActivitySpec & { text: string }) =>
      api.activity(ctx, spec).then(() => undefined);
    return {
      plan: (steps: LinearPlanStep[]) => api.updateSession(ctx, { plan: steps }),
      thought: (text: string, options?: { ephemeral?: boolean }) =>
        post({ type: "thought", text, ephemeral: options?.ephemeral ?? false }),
      action: (action: string, parameter: string, result?: string) =>
        post({ type: "action", text: action, action, parameter, result }),
      link: (label: string, url: string) =>
        api.updateSession(ctx, { addedExternalUrls: [{ label, url }] }),
      summary: async (text: string) => {
        const line = summaryLine(text);
        if (line) await api.updateSession(ctx, { summary: line });
      },
      session: api.handleFor(ctx),
    } satisfies Omit<LinearRunSurface, "react" | "unreact">;
  };
}

function activityContent(spec: LinearActivitySpec & { text: string }): Record<string, unknown> {
  switch (spec.type) {
    case "action":
      return {
        type: "action",
        action: spec.action ?? spec.text,
        parameter: spec.parameter ?? "",
        ...(spec.result !== undefined ? { result: spec.result } : {}),
      };
    default:
      return { type: spec.type, body: spec.text };
  }
}

const AGENT_ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

async function createAgentActivity(
  apiUrl: string,
  accessToken: string,
  agentSessionId: string,
  spec: LinearActivitySpec & { text: string }
): Promise<{ id?: string }> {
  const input: Record<string, unknown> = {
    agentSessionId,
    content: activityContent(spec),
  };
  if (spec.ephemeral && (spec.type === "thought" || spec.type === "action")) input.ephemeral = true;
  if (spec.signal) input.signal = spec.signal;
  if (spec.signalMetadata) input.signalMetadata = spec.signalMetadata;
  if (spec.id) input.id = spec.id;

  const data = await linearGraphql<{
    agentActivityCreate?: {
      success?: boolean;
      agentActivity?: { id?: string } | null;
    };
  }>(apiUrl, accessToken, AGENT_ACTIVITY_CREATE, { input });
  if (data.agentActivityCreate?.success === false) {
    throw new Error("linear agentActivityCreate failed: success=false");
  }
  return { id: data.agentActivityCreate?.agentActivity?.id ?? undefined };
}

const AGENT_SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;

async function updateAgentSession(
  apiUrl: string,
  accessToken: string,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  const data = await linearGraphql<{ agentSessionUpdate?: { success?: boolean } }>(
    apiUrl,
    accessToken,
    AGENT_SESSION_UPDATE,
    { id: agentSessionId, input }
  );
  if (data.agentSessionUpdate?.success === false) {
    throw new Error("linear agentSessionUpdate failed: success=false");
  }
}

/** A minimal GraphQL call against Linear's API with the app's OAuth token. */
export async function linearGraphql<T>(
  apiUrl: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  };
  if (!res.ok || (body.errors && body.errors.length > 0)) {
    const detail =
      body.errors?.map((e) => e.message ?? e.extensions?.code ?? "error").join("; ") ??
      `HTTP ${res.status}`;
    throw new Error(`linear graphql failed: ${detail}`);
  }
  if (!body.data) throw new Error("linear graphql failed: empty response");
  return body.data;
}

/** Cap for the serialized tool input in an elicitation body. */
const MAX_INTERACTION_INPUT_CHARS = 2500;

/**
 * Default HITL controls: one `elicitation` per pending human-decision tool, with a `select` signal
 * offering Approve and Deny. Linear shows the chosen option's value as the user's message and delivers
 * it back as a regular `prompted` activity. The value names the tool and the call
 * ("Approve createSubIssues [call_a]"), so each card resolves exactly the call whose input it shows,
 * even when an earlier turn left a same-named call pending; `onInteraction` still accepts a bare tool
 * name typed by hand.
 */
type ApprovalRenderer = NonNullable<LinearChannelOptions<unknown>["approvals"]>[string];

type ChoiceRenderer = NonNullable<LinearChannelOptions<unknown>["interactions"]>[string];

/** A select card for a tool with its own `interactions` entry; each option names the call it answers. */
function choiceCard(call: ChannelPendingToolCall, render: ChoiceRenderer, deliveryId?: string) {
  let rendered: ReturnType<ChoiceRenderer> = null;
  try {
    rendered = render(call);
  } catch (error) {
    logger.warn("linear: an interactions renderer threw; posting a note instead", {
      toolName: call.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const id = linearActivityId("elicitation", deliveryId, call.toolCallId);
  if (!rendered || rendered.options.length === 0) {
    return {
      id,
      type: "elicitation" as const,
      text: `\`${call.toolName}\` is waiting for an answer, but its options could not be shown.`,
    };
  }
  return {
    id,
    type: "elicitation" as const,
    text: rendered.title ? `**${rendered.title}**\n\n${rendered.body}` : rendered.body,
    signal: "select" as const,
    signalMetadata: {
      options: rendered.options.map((option) => ({
        label: option,
        value: `${option} [choice:${call.toolCallId}]`,
      })),
    },
  };
}

function makeLinearRenderInteraction(
  approvals?: Record<string, ApprovalRenderer>,
  interactions?: Record<string, ChoiceRenderer>
) {
  return (
    pending: ChannelPendingToolCall[],
    ctx: ChannelInteractionCtx<unknown>
  ): LinearChannelMessage | null => {
    if (pending.length === 0) return null;
    const activities = pending.map((call) => {
      const choice = interactions?.[call.toolName];
      if (choice) return choiceCard(call, choice, ctx.deliveryId);
      const target = `${call.toolName} [${call.toolCallId}]`;
      return {
        id: linearActivityId("elicitation", ctx.deliveryId, call.toolCallId),
        type: "elicitation" as const,
        text: approvalCard(call, approvals?.[call.toolName]),
        signal: "select" as const,
        signalMetadata: {
          options: [
            { label: "Approve", value: `Approve ${target}` },
            { label: "Deny", value: `Deny ${target}` },
          ],
        },
      };
    });
    return {
      text:
        pending.length === 1
          ? `Approval needed: ${pending[0]!.toolName}`
          : `Approval needed: ${pending.length} tool calls`,
      activities,
    };
  };
}

/** The markdown body of one approval card: a custom renderer's output, else the input laid out. */
export function approvalCard(call: ChannelPendingToolCall, custom?: ApprovalRenderer): string {
  if (custom) {
    try {
      const rendered = custom(call.input, call);
      if (rendered) {
        return rendered.title ? `**${rendered.title}**\n\n${rendered.body}` : rendered.body;
      }
    } catch (error) {
      logger.warn("linear: approvals renderer threw; falling back to the default card", {
        toolName: call.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const heading = `**Approval needed:** \`${call.toolName}\``;
  if (call.input === undefined) return heading;
  const body = inputToMarkdown(call.input);
  const shown =
    body.length > MAX_INTERACTION_INPUT_CHARS
      ? body.slice(0, MAX_INTERACTION_INPUT_CHARS) + "\n\n... (truncated)"
      : body;
  return `${heading}\n\n${shown}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function labelFor(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const TITLE_KEYS = ["title", "name", "summary", "subject", "label", "id"];

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  return safeStringify(v);
}

/**
 * Lay a tool input out as markdown for a person to read: an array of objects becomes a numbered list
 * with a bold title line and the other fields under it, a flat object becomes key and value bullets,
 * an array of scalars a bullet list. Anything deeper falls back to a JSON block.
 */
export function inputToMarkdown(input: unknown): string {
  if (isPlainObject(input)) {
    const keys = Object.keys(input);
    const arrayKeys = keys.filter((k) => Array.isArray(input[k]));
    if (keys.length === 1 && arrayKeys.length === 1) {
      const key = keys[0]!;
      return `${labelFor(key)}\n\n${inputToMarkdown(input[key])}`;
    }
    const lines: string[] = [];
    for (const key of keys) {
      const value = input[key];
      if (Array.isArray(value)) {
        lines.push(`- **${labelFor(key)}**`);
        lines.push(
          inputToMarkdown(value)
            .split("\n")
            .map((l) => (l ? `  ${l}` : l))
            .join("\n")
        );
      } else if (isPlainObject(value)) {
        lines.push(`- **${labelFor(key)}**`);
        for (const [k2, v2] of Object.entries(value)) {
          lines.push(`  - ${labelFor(k2)}: ${scalar(v2)}`);
        }
      } else {
        lines.push(`- **${labelFor(key)}:** ${scalar(value)}`);
      }
    }
    return lines.join("\n");
  }
  if (Array.isArray(input)) {
    if (input.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
      return input.map((item) => `- ${scalar(item)}`).join("\n");
    }
    if (input.every(isPlainObject)) {
      return input
        .map((item, i) => {
          const obj = item as Record<string, unknown>;
          const titleKey = TITLE_KEYS.find((k) => typeof obj[k] === "string");
          const title = titleKey ? String(obj[titleKey]) : `Item ${i + 1}`;
          const rest = Object.entries(obj).filter(([k]) => k !== titleKey);
          const details = rest.map(([k, v]) =>
            isPlainObject(v) || Array.isArray(v)
              ? `   - ${labelFor(k)}: \`${safeStringify(v)}\``
              : rest.length === 1 && typeof v === "string"
                ? `   ${v}`
                : `   - ${labelFor(k)}: ${scalar(v)}`
          );
          return [`${i + 1}. **${title}**`, ...details].join("\n");
        })
        .join("\n");
    }
  }
  if (input === undefined) return "";
  if (!isPlainObject(input) && !Array.isArray(input)) return scalar(input);
  return "```json\n" + safeStringify(input) + "\n```";
}

const DECISION_VALUE = /^\s*(Approve|Deny)\s+([A-Za-z0-9_.-]+)(?:\s+\[([^\]\s]+)\])?\s*$/;
/** Linear stores prompts as markdown, so `[` in an option value can come back as `\[`. */
const MARKDOWN_ESCAPE = /\\([\\`*_{}[\]()#+\-.!>|~])/g;
const CHOICE_VALUE = /^\s*([\s\S]+?)\s+\[choice:([^\]\s]+)\]\s*$/;

/**
 * Default interaction resolver: a `prompted` activity whose body is one of the option values ("Approve
 * createSubIssues", or "Approve createSubIssues [call_a]" when the card named the call) resolves that
 * tool call to `{ approved }`. Free text (or a `stop` signal) returns null and is handled as a normal
 * inbound message.
 */
function defaultLinearOnInteraction(event: unknown): ChannelInteractionResolution | null {
  const e = event as LinearAgentSessionEvent;
  if (e?.action !== "prompted" || isStopSignal(e)) return null;
  const raw = e.agentActivity?.content?.body;
  if (typeof raw !== "string") return null;
  const body =
    CHOICE_VALUE.test(raw) || DECISION_VALUE.test(raw) ? raw : raw.replace(MARKDOWN_ESCAPE, "$1");
  const choice = CHOICE_VALUE.exec(body);
  if (choice) return { toolCallId: choice[2]!, output: { selected: choice[1]! } };
  const m = DECISION_VALUE.exec(body);
  if (!m) return null;
  return {
    toolName: m[2]!,
    ...(m[3] ? { toolCallId: m[3] } : {}),
    output: { approved: m[1] === "Approve" },
  };
}

/**
 * After a decision, post a short non-ephemeral thought recording it. Linear dismisses the select UI
 * as soon as a newer activity arrives, so this both clears the card and leaves an audit line.
 */
function makeLinearFinalizeInteraction<TEvent>(api: LinearApi<TEvent>) {
  return async (event: TEvent, resolution: ChannelInteractionResolution): Promise<void> => {
    const e = event as unknown as LinearAgentSessionEvent;
    if (!linearSessionHandle(e)) return;
    const output = resolution.output as { approved?: boolean; selected?: string } | undefined;
    const who = userLabel(e.agentActivity?.user, e.agentActivity?.userId);
    const text =
      typeof output?.selected === "string"
        ? `${who} chose "${output.selected}".`
        : `${output?.approved === true ? "Approved" : "Denied"} by ${who}.`;
    await api.activity({ event }, { type: "thought", text });
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

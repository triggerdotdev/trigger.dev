import { chat } from "../ai.js";
import type {
  ChannelAckCtx,
  ChannelCancelledToolCall,
  ChannelDownloadedFile,
  ChannelConnector,
  ChannelControl,
  ChannelInbound,
  ChannelInteractionCtx,
  ChannelInteractionResolution,
  ChannelLifecycleCtx,
  ChannelLifecycleState,
  ChannelMessage,
  ChannelPendingToolCall,
  ChannelProgressEvent,
  ChannelReaction,
  ChannelReactions,
  ChannelReply,
  ChannelReplyStreamEnd,
  ChannelSeedMessage,
  ChannelSendCtx,
  ChannelStreamCtx,
  ChannelTurnCtx,
} from "../ai.js";
import type { WebhookEndpoint } from "@trigger.dev/core/v3";
import { DEFAULT_TEST_CONNECTOR_ID } from "./mock-chat-agent.js";

const DEFAULT_TEST_ENDPOINT_ID = "test-channel";

/** The default event shape {@link recordingChannelConnector} maps when no `inbound` is given. */
export type TestChannelEvent = { text: string; threadId?: string; userId?: string };

/** The posting handle the default `bind` derives: the event's `threadId`. */
export type TestChannelHandle = { threadId: string };

/** A single `send()` call captured by {@link recordingChannelConnector}. */
export type RecordedSend<TEvent = unknown> = {
  /** The channel message the connector was asked to post (or edit into place). */
  message: ChannelMessage;
  /** The egress context: `final`, `mode`, `previousRef`, the raw `event`, `deliveryId`. */
  ctx: ChannelSendCtx<TEvent>;
  /** The ref this send resolved to (echoes `previousRef` on an edit, else a fresh id). */
  ref: string;
};

/** A reaction applied to the triggering message, captured by {@link recordingChannelConnector}. */
export type RecordedReaction<TEvent = unknown> = { reaction: ChannelReaction; event: TEvent };

/** A `progress()` call, captured by {@link recordingChannelConnector}. */
type RecordedProgress<TEvent = unknown> = {
  event: ChannelProgressEvent;
  ctx: ChannelTurnCtx<TEvent>;
};

/** A `lifecycle()` report, captured by {@link recordingChannelConnector}. */
export type RecordedLifecycle<TEvent = unknown> = {
  state: ChannelLifecycleState;
  ctx: ChannelLifecycleCtx<TEvent>;
};

/** One turn's native reply stream (`stream: true`), captured by {@link recordingChannelConnector}. */
export type RecordedReplyStream<TEvent = unknown> = {
  ctx: ChannelTurnCtx<TEvent>;
  /** Every text delta, in order. */
  deltas: string[];
  progress: ChannelProgressEvent[];
  /** How the runtime ended the stream; unset while the turn runs. */
  ended?: ChannelReplyStreamEnd;
  /** How many times `end()` was called (the runtime ends each stream once). */
  endCalls: number;
};

/** A HITL `cancelInteraction()` call, captured by {@link recordingChannelConnector}. */
export type RecordedCancel<TEvent = unknown> = {
  cancelled: ChannelCancelledToolCall[];
  ctx: ChannelTurnCtx<TEvent>;
};

/** A HITL `finalizeInteraction()` call, captured by {@link recordingChannelConnector}. */
export type RecordedFinalize<TEvent = unknown> = {
  event: TEvent;
  resolution: ChannelInteractionResolution;
};

/**
 * A real {@link ChannelConnector} whose egress hooks record what they were
 * asked to do instead of touching a network, so a test can assert the channel
 * round-trip a `chat.agent` turn produced. Built through the real
 * `chat.channels.custom` factory, so it is a genuinely-shaped connector; only
 * `send` / `ack` / `react` / `finalizeInteraction` are swapped for recorders.
 */
export type RecordingChannelConnector<TEvent = unknown> = ChannelConnector<TEvent> & {
  /** Every `send()` call in order: the ack, any stream edits, and the final reply. */
  readonly sent: ReadonlyArray<RecordedSend<TEvent>>;
  /** Turn-start placeholder posts ("final" delivery): `final: false`, no `previousRef`. */
  readonly acks: ReadonlyArray<RecordedSend<TEvent>>;
  /** Stream-mode intermediate edits: `mode: "stream"`, `final: false`, with `previousRef`. */
  readonly edits: ReadonlyArray<RecordedSend<TEvent>>;
  /** Every reaction applied to the triggering message (lifecycle + `run().channel`). */
  readonly reactionsApplied: ReadonlyArray<RecordedReaction<TEvent>>;
  /** Every HITL `finalizeInteraction()` call. */
  readonly finalized: ReadonlyArray<RecordedFinalize<TEvent>>;
  /** Every `seed()` call's triggering event, in order. */
  readonly seeded: ReadonlyArray<TEvent>;
  /** Every `progress()` call (tool calls and results the turn streamed), in order. */
  readonly progressed: ReadonlyArray<RecordedProgress<TEvent>>;
  /** Every `lifecycle()` report, in order (`lifecycle: true`). */
  readonly lifecycles: ReadonlyArray<RecordedLifecycle<TEvent>>;
  /** Every native reply stream the runtime opened, one per turn (`stream: true`). */
  readonly streams: ReadonlyArray<RecordedReplyStream<TEvent>>;
  /** Every `cancelInteraction()` call. */
  readonly cancelled: ReadonlyArray<RecordedCancel<TEvent>>;
  /** Every `endInterruptedStream()` call: the ref of a stream a dead worker left open. */
  readonly interrupted: ReadonlyArray<{ ref: string; ctx: ChannelTurnCtx<TEvent> }>;
  /** The ref of the most recent `send()`, i.e. the current edit target. */
  readonly lastRef: string | undefined;
  /** Text of the final reply (`final: true`), or `undefined` if none posted yet. */
  finalText(): string | undefined;
};

/** Options for {@link recordingChannelConnector}. */
export type RecordingChannelConnectorOptions<TEvent = TestChannelEvent> = {
  /** Connector id. Defaults to {@link DEFAULT_TEST_CONNECTOR_ID} so it lines up with `sendChannelEvent`. */
  id?: string;
  /** The endpoint id the connector subscribes to. Server-side routing only; defaults to `"test-channel"`. */
  endpointId?: string;
  /** `"final"` (default: ack then edit-to-answer) or `"stream"` (debounced live edits). */
  delivery?: "final" | "stream";
  /** Session key template. Unused in-run (server-side routing only); defaults to `"{event.threadId}"`. */
  key?: string;
  /** Map the raw event to the turn's message. Defaults to `event.text`, attributed to `event.userId`. */
  inbound?: (event: TEvent) => ChannelInbound;
  /** Map the reply to the posted message. Defaults to `{ text }`; receives the full {@link ChannelReply}. */
  outbound?: (reply: ChannelReply) => ChannelMessage | null;
  /**
   * Derive the session's posting handle from an event, so turns that no channel delivery started
   * (an action turn, a browser message) still egress through this connector with `ctx.handle` and
   * `ctx.bound: true`. Defaults to `{ threadId: event.threadId }`; pass `null` to make the
   * connector unbindable.
   */
  bind?: ((event: TEvent) => unknown | null) | null;
  /** Prior surface messages to seed a new session with (what `seed()` returns). Recorded per call. */
  seed?: (event: TEvent) => Promise<ChannelSeedMessage[]> | ChannelSeedMessage[];
  /**
   * Placeholder posted at turn start ("final" delivery). Defaults to `{ text: "..." }`.
   * Pass `null` (or a function returning `null`) to post no ack, so the final reply
   * arrives as a fresh message instead of an edit.
   */
  ack?: ChannelMessage | null | ((event: TEvent, ctx: ChannelAckCtx) => ChannelMessage | null);
  /** HITL: map a verified callback event to a tool resolution (null => treat as a normal message). */
  onInteraction?: (event: TEvent) => ChannelInteractionResolution | null;
  /** Fetch a file URL the connector owns for the model; null for URLs it does not own. */
  download?: (url: URL, ctx: { handle?: unknown }) => Promise<ChannelDownloadedFile | null>;
  /** Map a click on an agent-posted control to an action for `onAction` (null for anything else). */
  toAction?: (event: TEvent) => unknown | null;
  /** Acknowledge a message that arrives while a turn is running. */
  received?: (ctx: ChannelTurnCtx<TEvent>) => Promise<void> | void;
  /** HITL: map the pending tool call(s) to the controls posted in the thread. */
  renderInteraction?: (
    pending: ChannelPendingToolCall[],
    ctx: ChannelInteractionCtx<TEvent>
  ) => ChannelMessage | null;
  /** Lifecycle reaction choices (working/done/error). Requires nothing extra; `react` is always recorded. */
  reactions?: ChannelReactions<TEvent>;
  /** Record tool-call progress (`progress()` hook). Off by default so existing turns post nothing extra. */
  progress?: boolean;
  /** Provider helpers merged into `run({ channel })`. */
  surface?: (ctx: ChannelTurnCtx<TEvent>) => Record<string, unknown>;
  /** Map an event to a control (`{ kind: "stop" }`) while a turn runs. */
  onControl?: (event: TEvent) => ChannelControl | null;
  /** Record `lifecycle()` reports. Off by default. */
  lifecycle?: boolean;
  /**
   * Stream replies natively (`delivery: "stream"` with a recording `stream()` hook): each turn's
   * deltas and end outcome land in `streams`, the stream reports `opened("stream_<n>")` on its
   * first delta, and it reports delivered when it saw text. `{ delivered: false }` reports every
   * stream undelivered, like a Slack stream whose fallback post of the rest of the reply failed.
   */
  stream?: boolean | { delivered: false };
};

/**
 * Create a {@link RecordingChannelConnector} for driving a `chat.agent`
 * channel turn offline. Pair it with `mockChatAgent(...).sendChannelEvent(...)`:
 * list the connector on the agent's `channels`, deliver an event, then assert
 * against `connector.sent` / `.acks` / `.edits` / `.finalText()`.
 *
 * @example
 * ```ts
 * const channel = recordingChannelConnector();
 * const agent = chat.agent({ id: "support", channels: [channel], run: ... });
 * const harness = mockChatAgent(agent);
 * await harness.sendChannelEvent({ event: { text: "hi", threadId: "t1" } });
 * expect(channel.finalText()).toBe("hello");
 * ```
 */
export function recordingChannelConnector<TEvent = TestChannelEvent>(
  options: RecordingChannelConnectorOptions<TEvent> = {}
): RecordingChannelConnector<TEvent> {
  const sent: RecordedSend<TEvent>[] = [];
  const reactionsApplied: RecordedReaction<TEvent>[] = [];
  const finalized: RecordedFinalize<TEvent>[] = [];
  const seeded: TEvent[] = [];
  const progressed: RecordedProgress<TEvent>[] = [];
  const lifecycles: RecordedLifecycle<TEvent>[] = [];
  const streams: RecordedReplyStream<TEvent>[] = [];
  const cancelled: RecordedCancel<TEvent>[] = [];
  const interrupted: Array<{ ref: string; ctx: ChannelTurnCtx<TEvent> }> = [];
  let refCounter = 0;
  let lastRef: string | undefined;

  const inbound =
    options.inbound ??
    ((event: TEvent): ChannelInbound => {
      const e = event as { text?: string; userId?: string; threadId?: string } | undefined;
      return { message: e?.text ?? "", externalUserId: e?.userId };
    });
  const bind =
    options.bind === null
      ? undefined
      : (options.bind ??
        ((event: TEvent) => {
          const threadId = (event as { threadId?: string } | undefined)?.threadId;
          return threadId ? ({ threadId } satisfies TestChannelHandle) : null;
        }));

  const ackFn: (event: TEvent, ctx: ChannelAckCtx) => ChannelMessage | null =
    options.ack === undefined
      ? () => ({ text: "..." })
      : typeof options.ack === "function"
        ? (options.ack as (event: TEvent, ctx: ChannelAckCtx) => ChannelMessage | null)
        : () => options.ack as ChannelMessage | null;

  const send = async (message: ChannelMessage, ctx: ChannelSendCtx<TEvent>) => {
    const ref = ctx.previousRef ?? `ref_${++refCounter}`;
    sent.push({ message, ctx, ref });
    lastRef = ref;
    return { ref };
  };

  const react = async (reaction: ChannelReaction, ctx: { event: TEvent }) => {
    reactionsApplied.push({ reaction, event: ctx.event });
  };

  const finalizeInteraction = async (event: TEvent, resolution: ChannelInteractionResolution) => {
    finalized.push({ event, resolution });
  };

  const connector = chat.channels.custom({
    id: options.id ?? DEFAULT_TEST_CONNECTOR_ID,
    endpoint: {
      id: options.endpointId ?? DEFAULT_TEST_ENDPOINT_ID,
      source: "custom",
    } as WebhookEndpoint<TEvent>,
    key: (options.key ?? "{event.threadId}") as never,
    inbound: inbound as (event: TEvent) => ChannelInbound,
    ...(bind ? { bind: bind as never } : {}),
    ...(options.seed
      ? {
          seed: (async (event: TEvent) => {
            seeded.push(event);
            return options.seed!(event);
          }) as never,
        }
      : {}),
    ack: ackFn as never,
    ...(options.outbound ? { outbound: options.outbound as never } : {}),
    send: send as never,
    react: react as never,
    finalizeInteraction: finalizeInteraction as never,
    ...(options.onInteraction ? { onInteraction: options.onInteraction as never } : {}),
    ...(options.download ? { download: options.download as never } : {}),
    ...(options.toAction ? { toAction: options.toAction as never } : {}),
    ...(options.received ? { received: options.received as never } : {}),
    ...(options.renderInteraction ? { renderInteraction: options.renderInteraction as never } : {}),
    ...(options.reactions ? { reactions: options.reactions as never } : {}),
    ...(options.progress
      ? {
          progress: ((event: ChannelProgressEvent, ctx: ChannelTurnCtx<TEvent>) => {
            progressed.push({ event, ctx });
          }) as never,
        }
      : {}),
    ...(options.surface ? { surface: options.surface as never } : {}),
    ...(options.onControl ? { onControl: options.onControl as never } : {}),
    ...(options.lifecycle
      ? {
          lifecycle: ((state: ChannelLifecycleState, ctx: ChannelLifecycleCtx<TEvent>) => {
            lifecycles.push({ state, ctx });
          }) as never,
        }
      : {}),
    ...(options.stream
      ? {
          stream: ((ctx: ChannelStreamCtx<TEvent>) => {
            const recorded: RecordedReplyStream<TEvent> = {
              ctx,
              deltas: [],
              progress: [],
              endCalls: 0,
            };
            streams.push(recorded);
            return {
              text: (delta: string) => {
                if (recorded.deltas.length === 0) ctx.opened(`stream_${streams.length}`);
                recorded.deltas.push(delta);
              },
              progress: (event: ChannelProgressEvent) => {
                recorded.progress.push(event);
              },
              end: async (outcome: ChannelReplyStreamEnd) => {
                recorded.endCalls += 1;
                recorded.ended = outcome;
                const undelivered =
                  typeof options.stream === "object" && options.stream.delivered === false;
                return { delivered: !undelivered && recorded.deltas.join("").length > 0 };
              },
            };
          }) as never,
        }
      : {}),
    endInterruptedStream: ((ref: string, ctx: ChannelTurnCtx<TEvent>) => {
      interrupted.push({ ref, ctx });
    }) as never,
    cancelInteraction: ((
      cancelledCalls: ChannelCancelledToolCall[],
      ctx: ChannelTurnCtx<TEvent>
    ) => {
      cancelled.push({ cancelled: cancelledCalls, ctx });
    }) as never,
    delivery: options.delivery ?? (options.stream ? "stream" : "final"),
  }) as ChannelConnector<TEvent>;

  Object.defineProperties(connector, {
    sent: { get: () => sent, enumerable: true },
    reactionsApplied: { get: () => reactionsApplied, enumerable: true },
    finalized: { get: () => finalized, enumerable: true },
    seeded: { get: () => seeded, enumerable: true },
    progressed: { get: () => progressed, enumerable: true },
    lifecycles: { get: () => lifecycles, enumerable: true },
    streams: { get: () => streams, enumerable: true },
    cancelled: { get: () => cancelled, enumerable: true },
    interrupted: { get: () => interrupted, enumerable: true },
    lastRef: { get: () => lastRef, enumerable: true },
    acks: {
      get: () => sent.filter((s) => s.ctx.final === false && s.ctx.previousRef === undefined),
      enumerable: true,
    },
    edits: {
      get: () =>
        sent.filter(
          (s) => s.ctx.mode === "stream" && s.ctx.final === false && s.ctx.previousRef !== undefined
        ),
      enumerable: true,
    },
  });

  (connector as RecordingChannelConnector<TEvent>).finalText = () => {
    for (let i = sent.length - 1; i >= 0; i--) {
      if (sent[i]!.ctx.final) return sent[i]!.message.text;
    }
    return undefined;
  };

  return connector as RecordingChannelConnector<TEvent>;
}

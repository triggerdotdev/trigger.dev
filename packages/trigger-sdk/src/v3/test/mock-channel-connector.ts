import { chat } from "../ai.js";
import type {
  ChannelAckCtx,
  ChannelConnector,
  ChannelInteractionCtx,
  ChannelInteractionResolution,
  ChannelMessage,
  ChannelMessageInput,
  ChannelPendingToolCall,
  ChannelReaction,
  ChannelReactions,
  ChannelSendCtx,
} from "../ai.js";
import { webhooks } from "../webhooks.js";
import { DEFAULT_TEST_CONNECTOR_ID } from "./mock-chat-agent.js";

/** The default event shape {@link recordingChannelConnector} maps when no `inbound` is given. */
export type TestChannelEvent = { text: string; threadId?: string };

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
  /** The ref of the most recent `send()`, i.e. the current edit target. */
  readonly lastRef: string | undefined;
  /** Text of the final reply (`final: true`), or `undefined` if none posted yet. */
  finalText(): string | undefined;
};

/** Options for {@link recordingChannelConnector}. */
export type RecordingChannelConnectorOptions<TEvent = TestChannelEvent> = {
  /** Connector id. Defaults to {@link DEFAULT_TEST_CONNECTOR_ID} so it lines up with `sendChannelEvent`. */
  id?: string;
  /** `"final"` (default: ack then edit-to-answer) or `"stream"` (debounced live edits). */
  delivery?: "final" | "stream";
  /** Session key template. Unused in-run (server-side routing only); defaults to `"{body.threadId}"`. */
  key?: string;
  /** Map the raw event to the turn's message. Defaults to reading `event.text`. */
  inbound?: (event: TEvent) => ChannelMessageInput;
  /**
   * Placeholder posted at turn start ("final" delivery). Defaults to `{ text: "..." }`.
   * Pass `null` (or a function returning `null`) to post no ack, so the final reply
   * arrives as a fresh message instead of an edit.
   */
  ack?: ChannelMessage | null | ((event: TEvent, ctx: ChannelAckCtx) => ChannelMessage | null);
  /** HITL: map a verified callback event to a tool resolution (null => treat as a normal message). */
  onInteraction?: (event: TEvent) => ChannelInteractionResolution | null;
  /** HITL: map the pending tool call(s) to the controls posted in the thread. */
  renderInteraction?: (
    pending: ChannelPendingToolCall[],
    ctx: ChannelInteractionCtx<TEvent>
  ) => ChannelMessage | null;
  /** Lifecycle reaction choices (working/done/error). Requires nothing extra; `react` is always recorded. */
  reactions?: ChannelReactions<TEvent>;
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
  let refCounter = 0;
  let lastRef: string | undefined;

  const inbound = options.inbound ?? ((event: TEvent) => (event as { text?: string })?.text ?? "");

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
    source: webhooks.custom<TEvent>({
      scheme: "shared-secret",
      placement: "header",
      fieldName: "x-test-signature",
    }),
    key: (options.key ?? "{body.threadId}") as never,
    inbound: inbound as (event: TEvent) => ChannelMessageInput,
    ack: ackFn as never,
    send: send as never,
    react: react as never,
    finalizeInteraction: finalizeInteraction as never,
    ...(options.onInteraction ? { onInteraction: options.onInteraction as never } : {}),
    ...(options.renderInteraction ? { renderInteraction: options.renderInteraction as never } : {}),
    ...(options.reactions ? { reactions: options.reactions as never } : {}),
    delivery: options.delivery ?? "final",
  }) as ChannelConnector<TEvent>;

  Object.defineProperties(connector, {
    sent: { get: () => sent, enumerable: true },
    reactionsApplied: { get: () => reactionsApplied, enumerable: true },
    finalized: { get: () => finalized, enumerable: true },
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

/**
 * Server-side helpers for the `chat.agent` head-start flow — a
 * customer's warm process (Next.js route handler, Express, etc.)
 * gets the conversation moving while the heavy chat.agent run boots
 * in parallel. Mid-turn, ownership of the durable stream hands over
 * to the agent.
 *
 * The `chat.headStart({ agentId, run })` entry point returns a
 * Next.js-style POST handler. Inside the customer's `run` callback
 * they call `streamText` themselves, spreading
 * `chat.toStreamTextOptions({ tools })` to inherit handover wiring.
 * The handler runs `streamText` step 1 in the customer's process
 * while the chat.agent run boots in parallel; on `tool-calls` the
 * agent run picks up tool execution and continues, on pure-text the
 * agent run exits clean without an LLM call.
 *
 * Two-layer naming: customer-facing surface is "head start"
 * (describes the *benefit* — fast first-turn TTFC). The internal
 * protocol still uses "handover" (describes the *mechanism* — the
 * conversation hands off mid-turn from the warm process to the
 * agent). Customers see `chat.headStart`, `HeadStartSession`, etc.
 * The wire format and run-loop locals stay on `handover` /
 * `handover-prepare` / `handover-skip`.
 *
 * Cooperative ordering only — handler stops writing to `session.out`
 * before sending the `handover` chunk on `session.in`. No S2 fencing.
 *
 * ⚠️ HARD CONSTRAINT — bundle isolation
 *
 * This module is the customer-facing boundary for the route handler.
 * The whole TTFC win comes from the customer's process being
 * lightweight while the heavy agent run boots in parallel. **The
 * route-handler bundle must not include heavy tool execute deps**:
 * E2B, puppeteer/playwright, native bindings, the trigger SDK
 * runtime, turndown, image processing libs, anything that pulls
 * weight or pulls `node:` builtins.
 *
 * "Schema-only" tools must live in a module that imports only `ai`
 * (for `tool()`) and `zod`. The agent task module imports those
 * schemas and adds execute fns elsewhere — that's where the heavy
 * deps live, and it's never reached by the route handler bundle.
 *
 * Runtime "strip executes" helpers (anything that takes a tool
 * catalog with executes and removes them) DO NOT solve this. The
 * import chain is resolved at bundle/build time, so importing the
 * full catalog drags every dep in regardless of what the SDK does
 * with the value at runtime.
 *
 * IMPORTANT (internal): this module must NOT import from `./ai.ts`.
 * `ai.ts` statically imports `agentSkillsRuntime` (which uses `node:`
 * builtins unfit for some serverless runtimes) and the heavy task
 * runtime. Allowed imports: `./ai-shared.js`, `./chat-client.js`,
 * `@trigger.dev/core/v3` (api client), `ai` (types + lightweight
 * helpers like `stepCountIs` / `convertToModelMessages`).
 */

import type {
  ApiClient} from "@trigger.dev/core/v3";
import {
  SessionStreamInstance,
  TRIGGER_CONTROL_SUBTYPE,
  apiClientManager,
  type ApiClientConfiguration,
  type SessionTriggerConfig,
} from "@trigger.dev/core/v3";
// Runtime VALUES via the ESM/CJS shim so the CJS build can `require` ESM-only
// `ai@7` (see ../imports/ai-runtime.ts).
import {
  convertToModelMessages,
  generateId as generateAssistantMessageId,
  stepCountIs,
} from "../imports/ai-runtime.js";
import type { FinishReason, ModelMessage, Tool, UIMessage, UIMessageChunk } from "ai";
import type { ChatInputChunk, ChatTaskWirePayload } from "./ai-shared.js";

// `StreamTextResult` is defined locally rather than imported from `ai`: its
// generic arity diverged (v6 `StreamTextResult<TOOLS, OUTPUT>`, v7
// `StreamTextResult<TOOLS, RUNTIME_CONTEXT, OUTPUT>`), so a fixed-arity import
// can't satisfy both majors. We only read these members off the customer's
// result; a real `StreamTextResult` (any version) is assignable to this.
type AnyStreamTextResult = {
  readonly finishReason: PromiseLike<FinishReason>;
  readonly response: PromiseLike<{ messages: ModelMessage[] }>;
  toUIMessageStream: (...args: any[]) => any;
  toUIMessageStreamResponse: (...args: any[]) => Response;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The options `toStreamTextOptions()` hands back to spread into `streamText`.
 * Typed concretely (rather than `Record<string, unknown>`) so the `messages`
 * AI SDK 7 requires is statically present, and so `streamText` infers its tools
 * from the call (rather than collapsing to `never` off a loose spread).
 *
 * `tools` and `stopWhen` are deliberately omitted: they're wired in at runtime,
 * but `streamText` reads them from the runtime value, and leaving them off the
 * type keeps it version-agnostic and avoids constraining the tool inference.
 */
export type HeadStartStreamTextOptions = {
  messages: ModelMessage[];
  abortSignal: AbortSignal;
};

export type HeadStartRunArgs<TTools extends Record<string, Tool>> = {
  /** User messages parsed from the incoming request. */
  messages: UIMessage[];
  /** Aborts when the request closes or the SDK times out the handover. */
  signal: AbortSignal;
  /** Helper exposing `toStreamTextOptions(...)` and a session escape hatch. */
  chat: HeadStartChatHelper<TTools>;
};

export type HeadStartChatHelper<TTools extends Record<string, Tool>> = {
  /**
   * Spread into the customer's `streamText` call to inherit handover
   * wiring. Returns options for:
   *
   * - `messages` — converted from the wire payload's UIMessages
   * - `tools` — the customer's tool set (typically schema-only — see
   *   the bundle-isolation note in this module's header)
   * - `abortSignal` — combined request-lifecycle + idle timeout
   * - `stopWhen` — `stepCountIs(1)`. Step 1 only. The agent run picks
   *   up tool execution and step 2+ after the handover signal.
   *
   * Customer adds `model`, `system`, `providerOptions`, etc. on top.
   * The customer keeps full control of the `streamText` call shape;
   * this helper just hands back the options the SDK needs to own.
   *
   * The customer COULD override any of these by re-setting them after
   * the spread, but doing so for `stopWhen` / `messages` /
   * `abortSignal` will break the handover protocol. The intent is
   * that customers spread first, then add only their own keys.
   */
  toStreamTextOptions(opts?: { tools?: TTools }): HeadStartStreamTextOptions;
  /** Lower-level escape hatch with manual `out` / `in` / dispatch primitives. */
  session: HeadStartSession;
};

export type HeadStartSession = {
  readonly chatId: string;
  /**
   * Tees a UIMessage stream into `session.out` for durability/resume,
   * fire-and-forget. Returns a passthrough that the caller can use as
   * the HTTP response body.
   */
  tee(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk>;
  /**
   * Awaits `result.finishReason` and dispatches `handover` (with the
   * partial assistant ModelMessages) or `handover-skip`.
   */
  handoverWhenDone(result: AnyStreamTextResult): Promise<void>;
  /**
   * Sugar over `tee` + `handoverWhenDone` + standard SSE response.
   * Returns a `Response` with `Content-Type: text/event-stream` whose
   * body is the teed stream.
   */
  handoverResponse(result: AnyStreamTextResult): Response;
  /**
   * Manually dispatch the `handover` signal on `session.in`.
   *
   * - `isFinal: true` — the partial assistant message IS the response.
   *   The agent runs `onChatStart` / `onTurnStart` / `onTurnComplete`
   *   against it but skips the LLM call. Use for pure-text replies.
   * - `isFinal: false` — the partial assistant message ends with
   *   pending tool calls. The agent executes them and then runs a
   *   step-2 LLM call to produce the final response.
   *
   * `messageId` lets the caller carry a stable assistant message id
   * across the handover boundary so the browser merges step 1 and
   * step 2 into the same `UIMessage`.
   */
  handover(args: {
    partialAssistantMessage: ModelMessage[];
    isFinal: boolean;
    messageId?: string;
  }): Promise<void>;
  /** Manually dispatch the `handover-skip` signal on `session.in`. */
  handoverSkip(): Promise<void>;
};

export type HeadStartHandlerOptions<TTools extends Record<string, Tool>> = {
  /** The `chat.agent({ id })` of the agent we're handing off to. */
  agentId: string;
  /**
   * Customer's first-turn implementation. Receives `messages`,
   * `signal`, and a `chat` helper. Should call `streamText` with
   * `...chat.toStreamTextOptions({ tools })` and return the
   * `StreamTextResult`.
   */
  run: (args: HeadStartRunArgs<TTools>) => Promise<AnyStreamTextResult>;
  /**
   * Seconds the agent run waits for the handover signal before
   * exiting. Defaults to 60.
   */
  idleTimeoutInSeconds?: number;
  /**
   * Run options for the auto-triggered `handover-prepare` session run —
   * tags, queue, machine, etc. Mirrors `chat.createStartSessionAction`.
   * The `chat:{chatId}` tag is prepended automatically.
   */
  triggerConfig?: Partial<SessionTriggerConfig>;
  /**
   * API client config (base URL + access token) for creating the session
   * and triggering the agent run. When set, the handler runs under this
   * config instead of the ambient `apiClientManager` config — use it when
   * the agent lives in a different project/env than the warm server's
   * default (mirrors `chat.createStartSessionAction`'s `apiClient` option).
   * The customer's LLM provider keys are unaffected; they stay in `run`.
   */
  apiClient?: ApiClientConfiguration;
};

export type StartHeadStartOptions<TTools extends Record<string, Tool>> = {
  /** The `chat.agent` / `chat.customAgent` / `chat.createSession` id to hand off to. */
  agentId: string;
  /** Stable chat id (the session externalId). You own it; reuse it on the destination page. */
  chatId: string;
  /** First-turn user history. Becomes the agent run's `headStartMessages`. */
  messages: UIMessage[];
  /** Your first-turn implementation — same shape as `chat.headStart`'s `run`. */
  run: (args: HeadStartRunArgs<TTools>) => Promise<AnyStreamTextResult>;
  /** Seconds the agent run waits for the handover signal before exiting. Default 60. */
  idleTimeoutInSeconds?: number;
  /** Run options for the auto-triggered `handover-prepare` run (tags, queue, machine, …). */
  triggerConfig?: Partial<SessionTriggerConfig>;
  /** API client config for session creation + trigger when the agent lives in another project/env. */
  apiClient?: ApiClientConfiguration;
  /** Metadata merged into the run's wire payload (auth tokens, context, …). Never sent to the browser. */
  metadata?: Record<string, unknown>;
};

export type StartHeadStartResult = {
  /** The chat id you passed in — echoed for convenience. */
  chatId: string;
  /**
   * Resolves once step 1 has drained to `session.out` and the handover is
   * dispatched. Hand to `waitUntil` / `after` on serverless; ignore it on a
   * long-lived server. Rejects if the warm step or the dispatch fails.
   */
  completion: Promise<void>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const chat = {
  /**
   * Returns a Next.js-style POST handler for the chat.agent
   * head-start flow. Customer mounts it as
   * `export const { POST } = chat.headStart({...})` (or
   * `export const POST = chat.headStart({...})`).
   *
   * Pair with the browser transport's `headStart: "/api/chat"`
   * option so the first message of a brand-new chat lands here
   * before the agent run boots.
   */
  headStart<TTools extends Record<string, Tool>>(
    opts: HeadStartHandlerOptions<TTools>
  ): (req: Request) => Promise<Response> {
    const handler = async (req: Request): Promise<Response> => {
      const session = await openHandoverSession({
        ...(await parseHandoverRequest(req)),
        agentId: opts.agentId,
        idleTimeoutInSeconds: opts.idleTimeoutInSeconds,
        triggerConfig: opts.triggerConfig,
      });

      const helper: HeadStartChatHelper<TTools> = {
        toStreamTextOptions(spreadOpts) {
          return session.buildStreamTextOptions(spreadOpts) as any;
        },
        session: session.handle,
      };

      const result = await opts.run({
        messages: session.uiMessages,
        signal: session.combinedSignal,
        chat: helper,
      });

      return session.handle.handoverResponse(result);
    };

    // Scope session creation + the agent trigger to `apiClient`'s env when
    // provided, so the agent can live in a different project/env than the warm
    // server's ambient config. The `run` callback's LLM keys are unaffected.
    const { apiClient } = opts;
    if (apiClient) {
      return async (req: Request) => apiClientManager.runWithConfig(apiClient, () => handler(req));
    }
    return handler;
  },

  /**
   * Detached head start for backends that create the chat AND trigger the
   * run in their own endpoint (e.g. a "create chat" API), then navigate the
   * browser to a separate page that resumes the chat. Unlike
   * `chat.headStart`, this does NOT return an SSE `Response`: it creates the
   * session, triggers the `handover-prepare` run, then streams step 1 from
   * your warm process straight into `session.out` and dispatches the
   * handover — all as the returned `completion` promise. The destination
   * page sees the whole turn (step 1 + the agent's step 2+) by resuming
   * `session.out`; no `headStart` transport option is needed there.
   *
   * `createSession` is awaited before this resolves, so the returned
   * `chatId` is immediately resumable. `completion` resolves once step 1 has
   * drained and the handover is dispatched — hand it to the platform's
   * "run after response" primitive (`waitUntil` / Next.js `after`) on
   * serverless, or ignore it on a long-lived server.
   *
   * @example
   * ```ts
   * const { chatId, completion } = await chat.startHeadStart({
   *   agentId: "my-chat",
   *   chatId,
   *   messages,
   *   run: async ({ chat: helper }) =>
   *     streamText({ ...helper.toStreamTextOptions({ tools }), model, system }),
   * });
   * waitUntil(completion); // serverless: keep warm until step 1 + handover finish
   * return Response.json({ chatId });
   * ```
   */
  async startHeadStart<TTools extends Record<string, Tool>>(
    opts: StartHeadStartOptions<TTools>
  ): Promise<StartHeadStartResult> {
    const open = () =>
      openHandoverSession({
        chatId: opts.chatId,
        uiMessages: opts.messages,
        wirePayload: {
          chatId: opts.chatId,
          trigger: "handover-prepare",
          headStartMessages: opts.messages,
          ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        } as ChatTaskWirePayload,
        agentId: opts.agentId,
        idleTimeoutInSeconds: opts.idleTimeoutInSeconds,
        triggerConfig: opts.triggerConfig,
      });

    // Scope session creation + the agent trigger to `apiClient`'s env when
    // provided (mirrors `chat.headStart`). The client captured inside
    // `openHandoverSession` is reused for the drain + handover dispatch, so
    // `completion` needs no further config scoping. LLM keys in `run` are
    // unaffected.
    const session = opts.apiClient
      ? await apiClientManager.runWithConfig(opts.apiClient, open)
      : await open();

    const helper: HeadStartChatHelper<TTools> = {
      toStreamTextOptions(spreadOpts) {
        return session.buildStreamTextOptions(spreadOpts) as any;
      },
      session: session.handle,
    };

    const completion = (async () => {
      let result: AnyStreamTextResult;
      try {
        result = await opts.run({
          messages: session.uiMessages,
          signal: session.combinedSignal,
          chat: helper,
        });
      } catch (err) {
        // The warm step never produced a result — tell the agent run to exit
        // clean instead of idle-waiting the full handover timeout.
        await session.handle.handoverSkip().catch(() => {});
        throw err;
      }
      // Stamp step 1 with the turn's stable messageId so the agent's step 2+
      // merges into the same assistant message, then drain it to session.out.
      const stream = result.toUIMessageStream({
        generateMessageId: () => session.turnMessageId,
      });
      session.drainToSessionOut(stream);
      // Awaits the drain, then dispatches handover / handover-skip. Owns its
      // own skip-on-error and idle-timer cleanup.
      await session.handle.handoverWhenDone(result);
    })();

    // Unhandled-rejection guard: a long-lived server that ignores `completion`
    // shouldn't crash under `--unhandled-rejections=throw`. Awaiting the
    // returned promise still surfaces the error.
    completion.catch(() => {});

    return { chatId: opts.chatId, completion };
  },

  /**
   * Lower-level primitive for power users who want to call
   * `streamText` themselves outside the `run` callback shape — custom
   * transforms, non-AI-SDK code paths, or manual control over the
   * response. Same wiring `chat.headStart` builds on internally.
   */
  openSession(opts: {
    req: Request;
    agentId: string;
    idleTimeoutInSeconds?: number;
    triggerConfig?: Partial<SessionTriggerConfig>;
  }): Promise<HeadStartSession> {
    return (async () => {
      const session = await openHandoverSession({
        ...(await parseHandoverRequest(opts.req)),
        agentId: opts.agentId,
        idleTimeoutInSeconds: opts.idleTimeoutInSeconds,
        triggerConfig: opts.triggerConfig,
      });
      return session.handle;
    })();
  },

  /**
   * Wrap a Web Fetch handler — `(req: Request) => Promise<Response>` —
   * as a Node `http` listener — `(req: IncomingMessage, res: ServerResponse) => Promise<void>`.
   *
   * Use this to mount `chat.headStart` (or any other Web Fetch
   * handler) inside Node-only frameworks like Express, Fastify, Koa,
   * or raw `node:http`. Web-native frameworks (Next.js App Router,
   * Hono, SvelteKit, Remix, Workers, Bun, Deno, etc.) don't need
   * this — they pass `Request` objects directly.
   *
   * Streams the response body chunk-by-chunk to the Node response,
   * so the `chat.headStart` SSE chunks reach the browser as they
   * arrive (no buffering). Aborts the underlying handler if the
   * client closes the connection.
   *
   * Type-only import of `node:http` types — no runtime dep on `node:http`,
   * so this stays safe to bundle into edge / Workers builds (the
   * function just won't be called there).
   *
   * @example
   * ```ts
   * import express from "express";
   * import { chat } from "@trigger.dev/sdk/chat-server";
   *
   * const handler = chat.headStart({
   *   agentId: "my-chat",
   *   run: async ({ chat: helper }) => streamText({ ... }),
   * });
   *
   * const app = express();
   * app.post("/api/chat", chat.toNodeListener(handler));
   * ```
   */
  toNodeListener,
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type InternalSession = {
  uiMessages: UIMessage[];
  combinedSignal: AbortSignal;
  handle: HeadStartSession;
  buildStreamTextOptions(spreadOpts?: { tools?: Record<string, Tool> }): Record<string, unknown>;
  /** Stable assistant messageId for this turn — stamp the detached drain with it. */
  turnMessageId: string;
  /**
   * Detached counterpart to `tee`: pump a UIMessage stream straight into
   * `session.out` with no HTTP response branch. Used by `chat.startHeadStart`,
   * where the browser picks the turn up by resuming `session.out` later.
   */
  drainToSessionOut(stream: ReadableStream<UIMessageChunk>): void;
};

/**
 * Parse the AI SDK transport's wire payload out of the route-handler
 * `Request` for `chat.headStart` / `chat.openSession`. The detached
 * `chat.startHeadStart` path skips this — it's handed the chatId and
 * messages directly.
 */
async function parseHandoverRequest(req: Request): Promise<{
  chatId: string;
  uiMessages: UIMessage[];
  wirePayload: ChatTaskWirePayload;
  requestSignal?: AbortSignal;
}> {
  const wirePayload = (await req.json()) as ChatTaskWirePayload;
  const chatId = wirePayload.chatId;
  if (!chatId) {
    throw new Error("[chat.handover] request body missing `chatId`");
  }
  // Slim wire — head-start ships full history via `headStartMessages` (not
  // `message`/`messages`) because the route handler runs on the customer's
  // own HTTP endpoint and isn't subject to the 512 KiB `/in/append` cap.
  const uiMessages = (wirePayload.headStartMessages ?? []) as UIMessage[];
  return {
    chatId,
    uiMessages,
    wirePayload,
    requestSignal: (req as Request & { signal?: AbortSignal }).signal,
  };
}

async function openHandoverSession(opts: {
  chatId: string;
  uiMessages: UIMessage[];
  /** Becomes the base wire payload for the `handover-prepare` run. */
  wirePayload: ChatTaskWirePayload;
  agentId: string;
  idleTimeoutInSeconds?: number;
  triggerConfig?: Partial<SessionTriggerConfig>;
  /** Request-lifecycle signal on the HTTP path; omitted on the detached path. */
  requestSignal?: AbortSignal;
}): Promise<InternalSession> {
  const { chatId, uiMessages, wirePayload } = opts;
  if (!chatId) {
    throw new Error("[chat.handover] missing `chatId`");
  }
  // The full UIMessage[] flows through `wirePayload` into the auto-trigger
  // `basePayload` below, where the agent run boot consumes it on first turn.
  // `convertToModelMessages` is async — resolve once up front so the
  // synchronous `toStreamTextOptions` builder can hand back a fully
  // formed object. AI SDK's `streamText` validates `messages` as a
  // `ModelMessage[]` synchronously and rejects a Promise.
  const modelMessages = await convertToModelMessages(uiMessages);

  const apiClient = resolveApiClient();
  // Top-level `idleTimeoutInSeconds` wins over the one in `triggerConfig`.
  const idleTimeoutInSeconds =
    opts.idleTimeoutInSeconds ?? opts.triggerConfig?.idleTimeoutInSeconds ?? 60;

  // Merge the customer's trigger options. `handover-prepare` and `chatId` in
  // `basePayload` are ours and can't be overridden; the `chat:{chatId}` tag is
  // prepended (SessionTriggerConfig.tags caps at 5).
  const userTags = opts.triggerConfig?.tags ?? [];
  const tags = [`chat:${chatId}`, ...userTags].slice(0, 5);

  const triggerConfig: SessionTriggerConfig = {
    basePayload: {
      ...(opts.triggerConfig?.basePayload ?? {}),
      ...wirePayload,
      chatId,
      trigger: "handover-prepare",
      idleTimeoutInSeconds,
    },
    ...(opts.triggerConfig?.machine ? { machine: opts.triggerConfig.machine } : {}),
    ...(opts.triggerConfig?.queue ? { queue: opts.triggerConfig.queue } : {}),
    tags,
    ...(opts.triggerConfig?.maxAttempts !== undefined
      ? { maxAttempts: opts.triggerConfig.maxAttempts }
      : {}),
    ...(opts.triggerConfig?.maxDuration !== undefined
      ? { maxDuration: opts.triggerConfig.maxDuration }
      : {}),
    ...(opts.triggerConfig?.region ? { region: opts.triggerConfig.region } : {}),
    ...(opts.triggerConfig?.lockToVersion
      ? { lockToVersion: opts.triggerConfig.lockToVersion }
      : {}),
    idleTimeoutInSeconds,
  };

  // Create the session and trigger the chat.agent's `handover-prepare`
  // run atomically. `createSession` is idempotent on `(env, externalId
  // = chatId)` and the auto-triggered run uses `triggerConfig.
  // basePayload` as the wire payload — so a single round-trip both
  // ensures the session exists and starts the agent booting with the
  // right trigger.
  //
  // Awaited intentionally: subsequent writes to `session.out` (the
  // tee from the customer's `streamText` to S2) need the session to
  // exist, and the handover signal at end-of-step-1 needs the agent
  // run to be there to consume it. The added latency (~one round trip
  // to the control plane) is bounded; the agent's compute boot still
  // overlaps with LLM TTFB.
  const created = await apiClient.createSession({
    type: "chat.agent",
    externalId: chatId,
    taskIdentifier: opts.agentId,
    triggerConfig,
  });
  const sessionPublicAccessToken = created.publicAccessToken;

  // Combined abort signal: request lifecycle OR an internal timeout
  // mirroring the agent's idle wait so a hung handler doesn't sit
  // forever.
  const abortController = new AbortController();
  const requestAbort = opts.requestSignal;
  if (requestAbort) {
    if (requestAbort.aborted) abortController.abort();
    else requestAbort.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  const idleTimer = setTimeout(
    () => abortController.abort(new Error("chat.handover: idle timeout")),
    idleTimeoutInSeconds * 1000
  );

  const buildStreamTextOptions = (spreadOpts?: {
    tools?: Record<string, Tool>;
  }): Record<string, unknown> => {
    // The customer spreads this object into their `streamText` call
    // and then adds `model`, `system`, etc. on top. We set the four
    // keys handover correctness depends on:
    //
    //   - `messages`: the wire payload's UIMessages, converted
    //     (Promise resolved upfront so the spread is synchronous)
    //   - `tools`: customer's schema-only tool set
    //   - `stopWhen`: `stepCountIs(1)` — step 1 only. Agent run picks
    //     up tool execution and step 2+ after the handover signal.
    //   - `abortSignal`: combined request-lifecycle + idle timeout
    //
    // The customer's `StreamTextResult` exposes `finishReason` and
    // `response.messages` directly, so we don't need to install an
    // `onStepFinish` capture hook — we read those off the result in
    // `handoverWhenDone`.
    return {
      messages: modelMessages,
      tools: spreadOpts?.tools,
      stopWhen: stepCountIs(1),
      abortSignal: abortController.signal,
    };
  };

  // Tee a UIMessage stream into session.out via S2 direct-write,
  // batched. `SessionStreamInstance` calls `initializeSessionStream`
  // once to fetch S2 credentials, then pipes via `StreamsWriterV2`'s
  // `BatchTransform` — one S2 append per ~200ms of chunks instead of
  // one HTTP round-trip per UIMessageChunk.
  let sessionWriter: SessionStreamInstance<UIMessageChunk> | null = null;
  const tee = (stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> => {
    const [a, b] = stream.tee();
    sessionWriter = new SessionStreamInstance<UIMessageChunk>({
      apiClient,
      baseUrl: apiClient.baseUrl,
      sessionId: chatId, // Sessions are addressable by externalId (chatId).
      io: "out",
      source: b,
      signal: abortController.signal,
    });
    return a;
  };
  // Detached drain (no HTTP response branch): hand the WHOLE stream to the S2
  // writer as its source. `StreamsWriterV2` self-pumps the source to S2, so the
  // stream drains to `session.out` without any reader pulling it. `handoverWhenDone`
  // awaits `flushSessionWriter()` before dispatching, so step 1 lands in order
  // ahead of the agent's step 2+.
  const drainToSessionOut = (stream: ReadableStream<UIMessageChunk>): void => {
    sessionWriter = new SessionStreamInstance<UIMessageChunk>({
      apiClient,
      baseUrl: apiClient.baseUrl,
      sessionId: chatId,
      io: "out",
      source: stream,
      signal: abortController.signal,
    });
  };
  /** Wait for the teed S2 writer to drain. Called before signaling handover. */
  const flushSessionWriter = async (): Promise<void> => {
    if (!sessionWriter) return;
    try {
      await sessionWriter.wait();
    } catch {
      // Drop write errors — the customer's response stream is the
      // source of truth for what the user sees. Durability/resume
      // best-effort.
    }
  };

  const handover = async (args: {
    partialAssistantMessage: ModelMessage[];
    messageId?: string;
    isFinal: boolean;
  }) => {
    const chunk: ChatInputChunk = {
      kind: "handover",
      partialAssistantMessage: args.partialAssistantMessage,
      messageId: args.messageId,
      isFinal: args.isFinal,
    };
    await apiClient.appendToSessionStream(chatId, "in", JSON.stringify(chunk));
  };

  /**
   * Sent only on dispatch error (handler aborted before producing a
   * `finishReason`). Normal pure-text and tool-call finishes go
   * through `handover()` with the appropriate `isFinal` flag.
   */
  // Clear the idle timer on every terminal path. The detached failure path
  // (run() throws -> handoverSkip) otherwise leaves it armed until the idle
  // timeout elapses, since only handoverWhenDone used to clear it.
  const cleanup = () => clearTimeout(idleTimer);

  const handoverSkip = async () => {
    try {
      const chunk: ChatInputChunk = { kind: "handover-skip" };
      await apiClient.appendToSessionStream(chatId, "in", JSON.stringify(chunk));
    } finally {
      cleanup();
    }
  };

  // A stable assistant messageId for this turn. The customer's
  // `toUIMessageStream` is configured to emit its `start` chunk with
  // this id, the handover signal carries it to the agent, and the
  // agent's post-handover `toUIMessageStream` reuses it — so all
  // chunks (customer's step 1 + agent's step 2) merge into one
  // assistant message on the browser side.
  const turnMessageId = generateAssistantMessageId();

  // Set by `handoverWhenDone` after it observes `result.finishReason`
  // and dispatches the handover decision. The stitched response stream
  // awaits this to know whether to close (skip) or pull more chunks
  // from session.out (handover).
  type HandoverDecision = { kind: "handover" | "handover-skip" };
  let resolveDecision!: (decision: HandoverDecision) => void;
  const decisionPromise = new Promise<HandoverDecision>((resolve) => {
    resolveDecision = resolve;
  });

  const handoverWhenDone = async (result: AnyStreamTextResult) => {
    // Owns idle-timer cleanup via the finally below, so both the
    // sugar (`handoverResponse`) and the escape-hatch
    // (`chat.openSession()` → `handle.handoverWhenDone(...)`) clean up
    // the timer the same way.
    try {
      // `result.finishReason` is a Promise<FinishReason> on the AI SDK
      // result. Wait for the stream to settle, then dispatch.
      const finishReason = await result.finishReason;

      // Drain the S2 tee so any in-flight handler writes (last
      // `tool-input-available` parts, the synthetic `finish-step` for
      // pure-text) are visible before the agent reads from session.out
      // / session.in. Cooperative ordering — agent doesn't read past
      // these unless we've finished writing them.
      await flushSessionWriter();

      const responseMessages = (await result.response).messages as ModelMessage[];

      if (finishReason === "tool-calls") {
        // Reshape pending tool-calls into AI SDK's tool-approval round
        // so the agent's `streamText` resumes by executing them
        // before the step-2 LLM call.
        const reshaped = reshapeForHandoverResume(responseMessages);
        await handover({
          partialAssistantMessage: reshaped,
          messageId: turnMessageId,
          isFinal: false,
        });
      } else {
        // Pure-text (or any non-tool-calls) finish — customer's step 1
        // IS the final response. The agent runs the turn-loop hooks
        // (`onChatStart`, `onTurnStart`, `onTurnComplete`, etc.) using
        // this partial as the response, but skips the LLM call. That
        // way persistence (`onTurnComplete` writing to DB), self-
        // review, and any post-turn work all fire normally.
        await handover({
          partialAssistantMessage: responseMessages,
          messageId: turnMessageId,
          isFinal: true,
        });
      }
      resolveDecision({ kind: "handover" });
    } catch (err) {
      // Dispatch failed before we could send the handover signal.
      // Tell the agent to exit clean (no hooks fire) and close the
      // response stream so it doesn't hang waiting for agent chunks.
      resolveDecision({ kind: "handover-skip" });
      try {
        await handoverSkip();
      } catch {
        // best-effort
      }
      throw err;
    } finally {
      cleanup();
    }
  };

  /**
   * Build a single ReadableStream that:
   *   1. Forwards the customer's `streamText` chunks (step 1) directly
   *      to the response — same low-latency path as before.
   *   2. After step 1 ends and the dispatch decision lands:
   *      - `handover-skip`: closes the response immediately. The agent
   *        run exits without writing more chunks.
   *      - `handover`: subscribes to `session.out` from the sequence
   *        ID where the customer's tee left off, forwarding the agent
   *        run's chunks (tool-output-available, step 2 LLM text,
   *        `finish-step`, etc.) until `trigger:turn-complete`.
   *
   * The browser sees one continuous SSE response per first turn, just
   * like a normal `streamText` would produce.
   */
  const stitchHandoverStream = (
    customerBranch: ReadableStream<UIMessageChunk>
  ): ReadableStream<UIMessageChunk> => {
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        try {
          // Phase 1: forward customer's chunks.
          const reader = customerBranch.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }

          // Phase 2a: wait for handoverWhenDone to decide.
          const decision = await decisionPromise;
          if (decision.kind === "handover-skip") {
            controller.close();
            return;
          }

          // Phase 2b: agent is taking over. Resume from session.out
          // starting AFTER the customer tee's last write, so we don't
          // re-emit chunks the browser already saw.
          const writeResult = sessionWriter
            ? await sessionWriter.wait().catch(() => undefined)
            : undefined;
          const customerLastEventId = writeResult?.lastEventId;

          // Capture the latest S2 event id seen on session.out via
          // `onPart`. After the stream closes we emit it to the
          // browser as a `trigger:session-state` control chunk so the
          // transport can hydrate `state.lastEventId` for turn 2's
          // subscribe — without it, turn 2 reads session.out from the
          // start and replays turn 1 to the user.
          //
          // The agent's `turn-complete` control record is now header-
          // form on S2 (see `client-protocol.mdx`), so the
          // `for await (const chunk of agentStream)` loop below NEVER
          // sees it as a data chunk — `subscribeToSessionStream` routes
          // it to `onControl`. Use that to know when to stop and
          // synthesise the data-chunk shape the browser bridge still
          // expects (this HTTP response stream is NOT S2 and keeps the
          // legacy chunk shape for the customer-server-to-browser hop).
          let latestEventId: string | undefined;
          let turnComplete = false;
          // Dedicated abort signal for this agent subscription. Aborted
          // from `onControl` the moment turn-complete fires so the
          // `for await` loop below exits immediately instead of blocking
          // until S2's long-poll closes (~60s). Combined with the outer
          // `abortController.signal` via `AbortSignal.any` so a request-
          // wide abort still tears the subscription down.
          const subscriptionAbort = new AbortController();
          const agentStream = await apiClient.subscribeToSessionStream<UIMessageChunk>(
            chatId,
            "out",
            {
              ...(customerLastEventId != null ? { lastEventId: customerLastEventId } : {}),
              signal: AbortSignal.any([abortController.signal, subscriptionAbort.signal]),
              onPart: (part) => {
                if (part.id) latestEventId = part.id;
              },
              onControl: (event) => {
                if (event.subtype === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                  turnComplete = true;
                  // Synthesise the data-chunk shape for the browser
                  // bridge. The customer-server-to-browser response is
                  // not S2; it keeps the legacy chunk shape so the
                  // browser's transport can recognise turn-complete the
                  // same way it always has.
                  controller.enqueue({
                    type: "trigger:turn-complete",
                  } as unknown as UIMessageChunk);
                  // Stop the SSE read now. Without this the `for await`
                  // can't see the control event (control records are
                  // never enqueued into the data stream) and would idle
                  // until S2's long-poll timeout closes the connection.
                  subscriptionAbort.abort();
                }
              },
            }
          );

          try {
            for await (const chunk of agentStream) {
              // Data records only — control records are routed via
              // `onControl` above and trigger the subscription abort.
              controller.enqueue(chunk);
              if (turnComplete) break;
            }
          } catch (err) {
            // AbortError from `subscriptionAbort` is the expected exit
            // path once turn-complete fires; surface anything else.
            const isAbort = err instanceof Error && err.name === "AbortError";
            if (!isAbort || !turnComplete) throw err;
          }

          // Final control chunk: hand the browser transport the
          // `lastEventId` it should use for the next turn's
          // session.out subscribe. Filtered out before reaching the
          // AI SDK on the browser side.
          if (latestEventId != null) {
            controller.enqueue({
              type: "trigger:session-state",
              lastEventId: latestEventId,
            } as unknown as UIMessageChunk);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        // Browser closed the connection. Trigger the abort so any
        // pending session.out subscription stops too.
        abortController.abort();
      },
    });
  };

  const handoverResponse = (result: AnyStreamTextResult): Response => {
    // `generateMessageId` makes the customer's `start` chunk carry
    // `turnMessageId`, so the browser-side AI SDK keys the assistant
    // message by it. The agent's post-handover stream emits chunks
    // with the same id (passed via the handover signal) — both sides
    // merge into one message on the browser.
    const teed = tee(
      result.toUIMessageStream({
        generateMessageId: () => turnMessageId,
      })
    );
    // `handoverWhenDone` re-throws on dispatch failure for visibility,
    // but the recovery (resolveDecision + handoverSkip) has already run
    // by then and `stitchHandoverStream` closes the response cleanly via
    // `decisionPromise`. The user-facing path is fine; we only suppress
    // the unhandled-rejection so processes started with
    // `--unhandled-rejections=throw` don't crash on what is effectively
    // a logged failure with no further action to take.
    // (Idle-timer cleanup lives inside `handoverWhenDone` itself.)
    void handoverWhenDone(result).catch(() => {});

    const stitched = stitchHandoverStream(teed);

    // Encode UIMessageChunks as SSE for the AI SDK transport on the
    // browser. AI SDK's `toUIMessageStreamResponse()` does this same
    // thing internally; replicate the format here so we don't have
    // to bridge through the SDK's response helper.
    const encoder = new TextEncoder();
    const sseStream = stitched.pipeThrough(
      new TransformStream<UIMessageChunk, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
      })
    );

    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "X-Vercel-AI-UI-Message-Stream": "v1",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Browser transport reads these to hydrate session state
        // for subsequent (non-handover) turns. Once the browser has
        // the PAT it talks directly to `session.in` / `session.out`
        // without going back through the handler.
        "X-Trigger-Chat-Id": chatId,
        "X-Trigger-Chat-Access-Token": sessionPublicAccessToken,
      },
    });
  };

  const handle: HeadStartSession = {
    chatId,
    tee,
    handoverWhenDone,
    handoverResponse,
    handover,
    handoverSkip,
  };

  return {
    uiMessages,
    combinedSignal: abortController.signal,
    handle,
    buildStreamTextOptions,
    turnMessageId,
    drainToSessionOut,
  };
}

function resolveApiClient(): ApiClient {
  // Reuse the SDK's standard apiClientManager so customers configure
  // base URL + secret key the same way as for `tasks.trigger(...)`.
  const client = apiClientManager.clientOrThrow();
  return client;
}

// ---------------------------------------------------------------------------
// Node `http` adapter
// ---------------------------------------------------------------------------

// Minimal Node http types we use. Avoids a `node:http` type import so the
// file stays lint-clean on non-Node TS projects (the docs example handlers
// might typecheck under workers / deno configs that lack `node:` types).
interface NodeIncomingHeaders {
  [k: string]: string | string[] | undefined;
}
interface NodeIncomingMessage extends AsyncIterable<unknown> {
  readonly url?: string;
  readonly method?: string;
  readonly headers: NodeIncomingHeaders;
  on(event: "error", listener: (err: Error) => void): unknown;
}
interface NodeServerResponse {
  statusCode: number;
  headersSent: boolean;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  write(chunk: Uint8Array | string): boolean;
  end(chunk?: Uint8Array | string): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

/** @internal — exposed via `chat.toNodeListener`. */
function toNodeListener(
  webHandler: (req: Request) => Promise<Response>
): (req: NodeIncomingMessage, res: NodeServerResponse) => Promise<void> {
  return async function nodeListener(req, res) {
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";

      // Read full body upfront. Chat wire payloads are small (sub-KB
      // typically) so accumulating avoids the duplex-stream ceremony
      // some Node versions need for streaming request bodies into
      // a Web Request.
      let body: ArrayBuffer | undefined;
      if (hasBody) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        if (chunks.length > 0) {
          let total = 0;
          for (const c of chunks) total += c.length;
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          body = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
        }
      }

      // Flatten Node header values: arrays → comma-joined (per RFC 7230 §3.2.2).
      const webHeaders = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const v of value) webHeaders.append(name, v);
        } else {
          webHeaders.set(name, value);
        }
      }

      const webReq = new Request(url, {
        method,
        headers: webHeaders,
        body,
        signal: abort.signal,
      });

      const webRes = await webHandler(webReq);

      res.statusCode = webRes.status;
      // `Headers.forEach` exposes the value comma-joined for multi-valued
      // headers, which `setHeader` accepts. Set-Cookie is handled separately
      // via `getSetCookie()` to preserve multiple values.
      webRes.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        res.setHeader(key, value);
      });
      const setCookies =
        typeof (webRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
        "function"
          ? (webRes.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
          : [];
      if (setCookies.length > 0) {
        res.setHeader("set-cookie", setCookies);
      }

      if (!webRes.body) {
        res.end();
        return;
      }

      // Pipe the Web Response body to the Node response. On client
      // disconnect (`abort.signal`), cancel the reader so a pending
      // `read()` rejects and we exit the loop instead of blocking on
      // a stream that will never produce more chunks.
      const reader = webRes.body.getReader();
      const onAbort = () => {
        reader.cancel(abort.signal.reason).catch(() => {});
      };
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener("abort", onAbort, { once: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Reader was cancelled (client disconnect). Silently end.
      } finally {
        abort.signal.removeEventListener("abort", onAbort);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(err instanceof Error ? err.message : "Internal error");
      } else {
        res.end();
      }
    }
  };
}

/**
 * Reshape a step-1 partial so the agent's `streamText` resumes by
 * executing pending tool-calls before the next LLM call.
 *
 * When the customer's handler runs `streamText` with schema-only tools
 * (no `execute` fns) and `stopWhen: stepCountIs(1)`, the LLM emits
 * tool-calls but AI SDK can't execute them — the partial we ship is
 * `[{ assistant: text + tool-call }]`. Splicing that as-is onto the
 * agent's accumulator and calling `streamText` throws
 * `MissingToolResultsError` synchronously inside
 * `convertToLanguageModelPrompt`.
 *
 * AI SDK's documented escape hatch for "external party decides what
 * to do with a tool-call, then SDK executes" is the tool-approval
 * round. By appending a `tool-approval-request` part to the assistant
 * message and a trailing `tool` message with a matching
 * `tool-approval-response { approved: true }`, AI SDK:
 *   1. Suppresses `MissingToolResultsError` for approved tool-calls
 *      (`convert-to-language-model-prompt.ts:135-144`).
 *   2. Hits its initial-tool-execution branch
 *      (`stream-text.ts:1342-1486`) on the next `streamText` call,
 *      runs the agent-side `execute` fns, and synthesizes
 *      `tool-result` parts before the step-2 LLM call.
 *
 * If the customer's tools already had `execute` fns (rare for the
 * handover use case but valid), the partial already contains a
 * `tool-result` per tool-call — we leave those alone and only inject
 * approvals for genuinely-pending calls.
 *
 * `collectToolApprovals` only scans the LAST message
 * (`collect-tool-approvals.ts:30-37`), so the synthesized tool message
 * must end up at the tail of the partial. The agent's run-loop
 * splices the partial onto the end of the accumulator, which keeps
 * this invariant.
 */
function reshapeForHandoverResume(responseMessages: ModelMessage[]): ModelMessage[] {
  // First pass: gather the set of tool-call IDs that already have a
  // matching tool-result. Those are "complete" — leave them alone.
  const completedToolCallIds = new Set<string>();
  for (const message of responseMessages) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === "tool-result" && part.toolCallId) {
        completedToolCallIds.add(part.toolCallId);
      }
    }
  }

  // Second pass: clone the messages, appending a tool-approval-request
  // alongside each pending tool-call. Collect the matching responses.
  const approvalResponses: Array<{
    type: "tool-approval-response";
    approvalId: string;
    approved: true;
  }> = [];
  let approvalCounter = 0;

  const reshaped: ModelMessage[] = responseMessages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") {
      return message;
    }
    const newContent: typeof message.content = [...message.content];
    for (const part of message.content as Array<{
      type: string;
      toolCallId?: string;
    }>) {
      if (
        part.type === "tool-call" &&
        part.toolCallId &&
        !completedToolCallIds.has(part.toolCallId)
      ) {
        const approvalId = `handover-approval-${++approvalCounter}`;
        newContent.push({
          type: "tool-approval-request",
          approvalId,
          toolCallId: part.toolCallId,
        } as never);
        approvalResponses.push({
          type: "tool-approval-response",
          approvalId,
          approved: true,
        });
      }
    }
    return { ...message, content: newContent } as ModelMessage;
  });

  if (approvalResponses.length > 0) {
    reshaped.push({
      role: "tool",
      content: approvalResponses as never,
    } as ModelMessage);
  }

  return reshaped;
}

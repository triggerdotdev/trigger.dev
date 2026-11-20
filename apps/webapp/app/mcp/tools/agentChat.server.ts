import type { TaskRunStatus } from "@trigger.dev/database";
import {
  controlSubtype,
  CreateSessionRequestBody,
  TRIGGER_CONTROL_SUBTYPE,
} from "@trigger.dev/core/v3";
import { tryCatch } from "@trigger.dev/core/utils";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  sanitizeClientInPart,
  stripClientIngressFieldsFromBasePayload,
} from "~/services/realtime/sanitizeSessionInput.server";
import {
  appendServerSessionRecord,
  ensureRunThenAppend,
} from "~/services/realtime/sessionChannelAppend.server";
import {
  isSafeSessionExternalId,
  SESSION_EXTERNAL_ID_FOLD_ERROR,
} from "~/services/realtime/sessionChannels.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";
import {
  canonicalSessionAddressingKey,
  findOrCreateSession,
  resolveSessionByIdOrExternalId,
  resolveSessionWithWriterFallback,
  serializeSessionWithFriendlyRunId,
} from "~/services/realtime/sessions.server";
import type { StreamRecord } from "~/services/realtime/types";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { runStore } from "~/v3/runStore.server";
import {
  mcpChatHandleStore,
  type McpChatHandle,
  type McpChatHandleStore,
} from "../chat/handleStore.server";
import { confirmationClient, confirmationTokenId } from "../confirm/confirmation.server";
import { fenceUntrusted } from "../gate/fence.server";
import { requiresApproval } from "../gate/approval.server";
import type { McpIdentity, McpSubject, McpToolAuth } from "../gate/types";
import {
  withMcpToolAuth,
  type McpToolContext,
  type McpToolResult,
} from "../gate/withMcpToolAuth.server";
import type { McpApprovalClass, McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import {
  CloseAgentChatInput,
  SendAgentMessageInput,
  StartAgentChatInput,
} from "./schemas/agentChat";

const MAX_WAIT_MS = 50_000;
const POLL_INTERVAL_MS = 750;
const RUN_STATUS_CHECK_INTERVAL_MS = 2_000;
const FINAL_READ_MS = 1_000;
const STATUS_GRACE_MS = 200;
const MAX_UPGRADE_RECURSION_DEPTH = 10;

type ChatMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string; [key: string]: unknown }>;
};

type Part = ChatMessage["parts"][number];

export type ChatStreamIO = {
  append: (part: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  read: (afterEventId: string | undefined) => Promise<StreamRecord[]>;
  currentRunId: () => Promise<string | undefined>;
  /** The last event id on `.out`, or undefined when it is empty. */
  lastEventId: () => Promise<string | undefined>;
  runStatus: (runId: string) => Promise<{ status: string; error?: string } | null>;
};

type CreatedChatSession =
  | { ok: true; sessionId: string; runId: string; isCached: boolean }
  | { ok: false; error: string };

const ChatBinding = z.object({ userId: z.string(), client: z.string(), task: z.string() });
type ChatBinding = z.infer<typeof ChatBinding>;

type CreateChatSession = (
  environment: AuthenticatedEnvironment,
  input: {
    chatId: string;
    agentId: string;
    binding: ChatBinding;
    clientData?: Record<string, unknown>;
  }
) => Promise<CreatedChatSession>;

export type AgentChatToolsOptions = {
  store?: McpChatHandleStore;
  createSession?: CreateChatSession;
  streamIO?: (
    environment: AuthenticatedEnvironment,
    sessionId: string,
    canTrigger: (taskIdentifier: string) => boolean
  ) => ChatStreamIO;
  maxWaitMs?: number;
  pollIntervalMs?: number;
};

function messageId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function decodeRecord(record: StreamRecord): { control?: string; chunk?: Record<string, unknown> } {
  const raw: unknown = record.data;
  let chunk: unknown = raw;
  if (typeof raw === "string") {
    try {
      chunk = raw ? JSON.parse(raw) : undefined;
    } catch {
      chunk = undefined;
    }
  }
  const object =
    chunk && typeof chunk === "object" ? (chunk as Record<string, unknown>) : undefined;

  const control = controlSubtype(record.headers);
  if (control) return { control };

  // Agents that predate header control records still write them as data chunks.
  const type = object?.type;
  if (type === "trigger:turn-complete") return { control: TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE };
  if (type === "trigger:upgrade-required") {
    return { control: TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED };
  }
  if (typeof type === "string" && type.startsWith("trigger:")) return { control: type };
  return { chunk: object };
}

function applyChunk(parts: Part[], chunk: Record<string, unknown>, textId: { current?: string }) {
  if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
    const id = (chunk.id as string) ?? "text";
    const last = parts[parts.length - 1];
    if (textId.current === id && last?.type === "text") {
      last.text = (last.text as string) + chunk.delta;
    } else {
      textId.current = id;
      parts.push({ type: "text", text: chunk.delta });
    }
  }

  if (chunk.type === "tool-input-available" && typeof chunk.toolName === "string") {
    parts.push({
      type: `tool-${chunk.toolName}`,
      toolCallId: chunk.toolCallId as string,
      toolName: chunk.toolName,
      state: "input-available",
      input: chunk.input,
    });
  }

  if (chunk.type === "tool-output-available" && typeof chunk.toolCallId === "string") {
    const toolPart = parts.find((p) => p.toolCallId === chunk.toolCallId);
    if (toolPart) {
      toolPart.state = "output-available";
      toolPart.output = chunk.output;
    }
  }
}

/** Resolves undefined once the deadline passes or the signal aborts. */
function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal
): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => resolve(undefined));
    const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

async function collectTurn(
  io: ChatStreamIO,
  afterEventId: string | undefined,
  options: {
    deadline: number;
    pollIntervalMs: number;
    signal: AbortSignal;
    drain?: boolean;
    runId?: string;
  }
) {
  let cursor = afterEventId;
  let parts: Part[] = [];
  let textId: { current?: string } = {};
  let upgrades = 0;
  let lastStatusCheck = 0;

  const checkFailed = async () => {
    lastStatusCheck = Date.now();
    if (!options.runId) return undefined;
    const lookup = io.runStatus(options.runId);
    lookup.catch(() => {});
    const [statusError, run] = await tryCatch(
      withinDeadline(
        lookup,
        Math.max(options.deadline, Date.now() + STATUS_GRACE_MS),
        options.signal
      )
    );
    if (statusError || !run || !isFinalRunStatus(run.status as TaskRunStatus)) return undefined;
    if (run.status === "COMPLETED_SUCCESSFULLY") return undefined;
    return { status: run.status, error: run.error };
  };

  let failed: Awaited<ReturnType<typeof checkFailed>>;
  let finalDeadline = 0;
  const detectFailure = async () => {
    failed = await checkFailed();
    if (failed) finalDeadline = Date.now() + FINAL_READ_MS;
    return failed;
  };

  while (true) {
    const records = await withinDeadline(
      io.read(cursor),
      failed ? finalDeadline : options.deadline,
      options.signal
    );
    if (failed && !records) {
      return { complete: false, parts, cursor, upgraded: upgrades > 0, failed };
    }
    if (!records || (options.drain && records.length === 0)) {
      if (await detectFailure()) continue;
      return { complete: false, parts, cursor, upgraded: upgrades > 0 };
    }

    for (const record of records) {
      cursor = String(record.seqNum);
      const { control, chunk } = decodeRecord(record);

      if (control === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
        return { complete: true, parts, cursor, upgraded: upgrades > 0 };
      }
      if (control === TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED) {
        upgrades++;
        if (upgrades > MAX_UPGRADE_RECURSION_DEPTH) {
          throw new Error(
            `Agent upgrade recursion depth exceeded (${upgrades} chained trigger:upgrade-required signals)`
          );
        }
        parts = [];
        textId = {};
        continue;
      }
      if (chunk) applyChunk(parts, chunk, textId);
    }

    if (failed) {
      if (records.length > 0 && Date.now() < finalDeadline) continue;
      return { complete: false, parts, cursor, upgraded: upgrades > 0, failed };
    }

    const remaining = options.deadline - Date.now();
    if (remaining <= 0 || options.signal.aborted) {
      if (await detectFailure()) continue;
      return { complete: false, parts, cursor, upgraded: upgrades > 0 };
    }
    if (options.drain) continue;
    if (Date.now() - lastStatusCheck >= RUN_STATUS_CHECK_INTERVAL_MS) {
      if (await detectFailure()) continue;
    }
    await sleep(Math.min(options.pollIntervalMs, remaining), undefined, {
      signal: options.signal,
    }).catch(() => {});
  }
}

function compactJson(value: unknown): string {
  const str = JSON.stringify(value);
  if (str.length <= 200) return str;
  return str.slice(0, 200) + "…";
}

function formatAssistantParts(parts: Part[]): string {
  const sections: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      sections.push(part.text);
    } else if (part.type.startsWith("tool-") && part.toolName) {
      let toolSection = `[Tool: ${part.toolName as string}]`;
      if (part.input != null) toolSection += `\nInput: ${compactJson(part.input)}`;
      if (part.output != null) toolSection += `\nOutput: ${compactJson(part.output)}`;
      sections.push(toolSection);
    }
  }

  return sections.join("\n\n");
}

function continuationNote(handle: McpChatHandle) {
  const cursor = handle.lastEventId ? `, afterEventId "${handle.lastEventId}"` : "";
  return `\n\nThe reply is still in progress. Continue with read_session_channel(sessionId "${handle.sessionId}"${cursor}, timeoutInSeconds up to 50).`;
}

function replyText(parts: Part[]) {
  const formatted = formatAssistantParts(parts);
  return formatted ? fenceUntrusted(formatted, "agent") : "";
}

async function sendAgentTurn({
  handle,
  chatId,
  message,
  io,
  persist,
  maxWaitMs = MAX_WAIT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  signal,
}: {
  handle: McpChatHandle;
  chatId: string;
  message: string;
  io: ChatStreamIO;
  persist: (handle: McpChatHandle) => Promise<void>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  signal: AbortSignal;
}): Promise<McpToolResult> {
  const deadline = Date.now() + maxWaitMs;
  let state = handle;

  if (state.turnInFlight) {
    const prior = await collectTurn(io, state.lastEventId, {
      deadline,
      pollIntervalMs,
      signal,
      drain: true,
    });
    state = { ...state, lastEventId: prior.cursor, turnInFlight: !prior.complete };
    if (!prior.complete) {
      await persist(state);
      return textResult(
        `The previous reply is still in progress.${replyText(prior.parts) ? `\n\n${replyText(prior.parts)}` : ""}${continuationNote(state)}`
      );
    }
  }

  const userMessage: ChatMessage = {
    id: messageId(),
    role: "user",
    parts: [{ type: "text", text: message }],
  };
  const appended = await io.append(
    JSON.stringify({
      kind: "message",
      payload: {
        message: userMessage,
        chatId,
        trigger: "submit-message",
        metadata: state.clientData,
      },
    })
  );
  if (!appended.ok) {
    await persist(state);
    return errorResult(appended.error);
  }

  state = { ...state, turnInFlight: true, runId: (await io.currentRunId()) ?? state.runId };
  await persist(state);

  const turn = await collectTurn(io, state.lastEventId, {
    deadline,
    pollIntervalMs,
    signal,
    runId: state.runId,
  });
  state = {
    ...state,
    lastEventId: turn.cursor,
    turnInFlight: !turn.complete && !turn.failed,
    runId: turn.upgraded ? ((await io.currentRunId()) ?? state.runId) : state.runId,
  };
  await persist(state);

  if (turn.failed) {
    const partial = replyText(turn.parts);
    const detail = fenceUntrusted(turn.failed.error ?? "no error message", "agent-run-error");
    return errorResult(
      `The agent run ${state.runId} failed (${turn.failed.status}): ${detail}${partial ? `\n\n${partial}` : ""}`
    );
  }

  const footer = `\n\n---\nRun: ${state.runId}`;
  return textResult(
    replyText(turn.parts) + footer + (turn.complete ? "" : continuationNote(state))
  );
}

function sessionStreamIO(
  environment: AuthenticatedEnvironment,
  sessionId: string,
  canTrigger: (taskIdentifier: string) => boolean
): ChatStreamIO {
  let stream: Promise<{ instance: S2RealtimeStreams; key: string }> | undefined;
  const outStream = () =>
    (stream ??= resolveSessionWithWriterFallback(environment.id, sessionId).then((session) => {
      const instance = session && getRealtimeStreamInstance(environment, "v2", { session });
      if (!(instance instanceof S2RealtimeStreams)) {
        throw new Error("Session channels require the S2 realtime backend");
      }
      return { instance, key: canonicalSessionAddressingKey(session, sessionId) };
    }));

  return {
    append: async (part) => {
      const session = await resolveSessionWithWriterFallback(environment.id, sessionId);
      if (!session) return { ok: false, error: "Session not found" };
      if (session.closedAt) return { ok: false, error: "Cannot append to a closed session" };
      if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
        return { ok: false, error: "Cannot append to an expired session" };
      }
      if (!canTrigger(session.taskIdentifier)) {
        return {
          ok: false,
          error: "Sending to this chat needs permission to trigger its agent task",
        };
      }

      const result = await ensureRunThenAppend({
        session,
        environment,
        addressingKey: canonicalSessionAddressingKey(session, sessionId),
        io: "in",
        part: sanitizeClientInPart(part).part,
        reason: "continuation",
      });
      if (result.ok) return { ok: true };
      if (result.kind === "unsupported_backend") {
        return { ok: false, error: "Session channels require the S2 realtime backend" };
      }
      if (result.kind === "rejected") return { ok: false, error: result.message };
      throw result.error;
    },
    read: async (afterEventId) => {
      const { instance, key } = await outStream();
      return instance.readSessionStreamRecords(
        key,
        "out",
        afterEventId !== undefined ? Number(afterEventId) : undefined
      );
    },
    currentRunId: async () => {
      const session = await resolveSessionByIdOrExternalId(prisma, environment.id, sessionId);
      if (!session) return undefined;
      return (await serializeSessionWithFriendlyRunId(session)).currentRunId ?? undefined;
    },
    runStatus: async (runId) => {
      const run = await runStore.findRun(
        { friendlyId: runId, runtimeEnvironmentId: environment.id },
        { select: { status: true, error: true } },
        $replica
      );
      if (!run) return null;
      const error = run.error as { message?: string; code?: string } | null;
      return { status: run.status, error: error?.message ?? error?.code };
    },
    lastEventId: async () => {
      const { instance, key } = await outStream();
      const tail = await instance.readSessionOutTailSeq(key);
      if (tail === undefined) throw new Error("Could not read the session's out tail");
      return tail > 0 ? String(tail - 1) : undefined;
    },
  };
}

const createChatSession: CreateChatSession = async (
  environment,
  { chatId, agentId, binding, clientData }
) => {
  if (!isSafeSessionExternalId(chatId)) return { ok: false, error: SESSION_EXTERNAL_ID_FOLD_ERROR };

  const body = CreateSessionRequestBody.safeParse({
    type: "chat.agent",
    externalId: chatId,
    taskIdentifier: agentId,
    triggerConfig: {
      basePayload: {
        messages: [],
        trigger: "preload",
        chatId,
        ...(clientData ? { metadata: clientData } : {}),
      },
      tags: [`chat:${chatId}`],
    },
  });
  if (!body.success) return { ok: false, error: body.error.message };

  const triggerConfig = {
    ...body.data.triggerConfig,
    basePayload: stripClientIngressFieldsFromBasePayload(body.data.triggerConfig.basePayload),
  };

  try {
    const { session, isCached } = await findOrCreateSession({
      environment,
      externalId: chatId,
      type: body.data.type,
      taskIdentifier: agentId,
      triggerConfig,
      metadata: { mcpBinding: binding },
      refreshTriggerConfig: false,
    });

    if (isCached) {
      const stored = z.object({ mcpBinding: ChatBinding }).safeParse(session.metadata);
      if (!stored.success) {
        return { ok: false, error: "This chat was started without a binding; start a new chatId" };
      }
      const { userId, client, task } = stored.data.mcpBinding;
      if (
        userId !== binding.userId ||
        client !== binding.client ||
        task !== binding.task ||
        session.taskIdentifier !== binding.task
      ) {
        return {
          ok: false,
          error: "This chat belongs to another client or agent; use a new chatId",
        };
      }
    }

    if (session.closedAt) {
      return {
        ok: false,
        error: "Session is closed; use a different externalId to create a new session",
      };
    }
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      return {
        ok: false,
        error: "Session is expired; use a different externalId to create a new session",
      };
    }

    const ensured = await ensureRunForSession({
      session,
      environment,
      reason: isCached ? "continuation" : "initial",
    });
    const run = await runStore.findRun(
      { id: ensured.runId },
      { select: { friendlyId: true } },
      prisma
    );
    if (!run) throw new Error(`Triggered run ${ensured.runId} not found`);

    return { ok: true, sessionId: session.friendlyId, runId: run.friendlyId, isCached };
  } catch (error) {
    if (error instanceof ServiceValidationError) return { ok: false, error: error.message };
    throw error;
  }
};

function findHandleEnvironment(handle: McpChatHandle, userId: string) {
  return $replica.runtimeEnvironment.findFirst({
    where: {
      id: handle.environmentId,
      projectId: handle.projectId,
      archivedAt: null,
      ...(handle.environmentType === "DEVELOPMENT" ? { orgMember: { userId } } : {}),
      project: {
        deletedAt: null,
        organizationId: handle.organizationId,
        organization: { deletedAt: null, members: { some: { userId } } },
      },
    },
    select: { id: true, type: true },
  });
}

const chatHandleScope = (identity: McpIdentity) =>
  `${confirmationTokenId(identity)}:${confirmationClient(identity)}`;

const chatBindingClient = (identity: McpIdentity) =>
  identity.kind === "pat" ? `pat:${identity.tokenId}` : confirmationClient(identity);

const canTriggerTask =
  (ctx: McpToolContext, envType: AuthenticatedEnvironment["type"]) => (taskIdentifier: string) =>
    ctx.ability?.can("trigger", { type: "tasks", id: taskIdentifier, envType }) ?? false;

const noActiveChat = (chatId: string, hint = "") =>
  errorResult(`No active chat with ID "${chatId}".${hint}`);

export function createAgentChatTools(options: AgentChatToolsOptions = {}): McpToolDefinition[] {
  const store = () => options.store ?? mcpChatHandleStore();
  const createSession = options.createSession ?? createChatSession;
  const streamIO = options.streamIO ?? sessionStreamIO;

  // The gate resolves the subject from the caller's own handle; a missing handle is reported
  // with the CLI's text instead of the gate's denial.
  const defineHandleTool = <S extends { chatId: z.ZodString } & z.ZodRawShape>(tool: {
    name: string;
    title: string;
    description: string;
    shape: S;
    approval: McpApprovalClass;
    missing: (chatId: string) => McpToolResult;
    run: (
      input: z.output<z.ZodObject<S>>,
      handle: McpChatHandle,
      ctx: McpToolContext
    ) => Promise<McpToolResult>;
  }): McpToolDefinition => {
    const schema = z.object(tool.shape);
    const missing = new WeakSet<object>();
    const handles = new WeakMap<object, McpChatHandle>();

    const resolveSubject = async (
      args: unknown,
      identity: McpIdentity
    ): Promise<McpSubject | null> => {
      const { chatId } = args as { chatId: string };
      const handle = await store().get(identity.userId, chatHandleScope(identity), chatId);
      if (!handle) {
        missing.add(args as object);
        return null;
      }

      // Re-check membership: the handle outlives a removal from the org.
      const environment = await findHandleEnvironment(handle, identity.userId);
      if (!environment) {
        await store().delete(identity.userId, chatHandleScope(identity), chatId);
        return null;
      }
      handles.set(args as object, handle);
      return {
        organizationId: handle.organizationId,
        projectId: handle.projectId,
        environmentId: environment.id,
        environmentType: environment.type,
      };
    };

    const auth: McpToolAuth = {
      action: "write",
      subject: "sessions",
      confirm: false,
      resolveSubject,
    };
    const gated = withMcpToolAuth(
      auth,
      (input: z.output<z.ZodObject<S>>, ctx) => tool.run(input, handles.get(input)!, ctx),
      tool.name
    );

    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.shape,
      annotations: { title: tool.title, readOnlyHint: false, destructiveHint: true },
      confirm: requiresApproval(auth) !== false,
      approval: tool.approval,
      auth,
      handler: async (args, identity, request, extra) => {
        const parsed = schema.safeParse(args ?? {});
        if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
        const result = await gated(parsed.data, identity, request, extra);
        return missing.has(parsed.data)
          ? tool.missing((parsed.data as { chatId: string }).chatId)
          : result;
      },
    };
  };

  return [
    defineWriteTool({
      name: "start_agent_chat",
      title: "Start Agent Chat",
      description:
        "Start a conversation with a chat agent. Returns a chatId you can use with send_agent_message. Optionally preloads the agent so it initializes before the first message.",
      shape: StartAgentChatInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "sessions" },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const canTrigger = canTriggerTask(ctx, environment.type);
        if (!canTrigger(input.agentId)) {
          return fencedError(
            `Starting this chat needs permission to trigger the ${input.agentId} task`,
            "agent-chat-error"
          );
        }

        const chatId = input.chatId ?? randomUUID();
        const existing = await store().get(
          ctx.identity.userId,
          chatHandleScope(ctx.identity),
          chatId
        );
        if (existing) {
          return textResult(
            `Chat ${chatId} is already active with agent ${existing.agentId}. Use send_agent_message to continue the conversation.`
          );
        }

        const session = await createSession(environment, {
          chatId,
          agentId: input.agentId,
          binding: {
            userId: ctx.identity.userId,
            client: chatBindingClient(ctx.identity),
            task: input.agentId,
          },
          clientData: input.clientData,
        });
        if (!session.ok) return errorResult(session.error);

        // A reused session already has replies on .out; start after them.
        let lastEventId: string | undefined;
        if (session.isCached) {
          const tail = await withinDeadline(
            streamIO(environment, session.sessionId, canTrigger)
              .lastEventId()
              .then((id) => ({ id })),
            Date.now() + (options.maxWaitMs ?? MAX_WAIT_MS),
            ctx.signal
          );
          if (!tail) return errorResult("Timed out reading the session. Try again.");
          lastEventId = tail.id;
        }

        await store().put(ctx.identity.userId, chatHandleScope(ctx.identity), chatId, {
          lastEventId,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          environmentId: environment.id,
          environmentType: environment.type,
          sessionId: session.sessionId,
          agentId: input.agentId,
          runId: session.runId,
          clientData: input.clientData,
          turnInFlight: false,
        });

        return textResult(
          [
            `Agent chat started${input.preload ? " and preloaded" : ""}.`,
            `- Chat ID: ${chatId}`,
            `- Session ID: ${session.sessionId}`,
            `- Agent: ${input.agentId}`,
            `- Run ID: ${session.runId}`,
            ``,
            `Use send_agent_message with chatId "${chatId}" to send messages.`,
          ].join("\n")
        );
      },
    }),
    defineHandleTool({
      name: "send_agent_message",
      title: "Send Agent Message",
      description:
        "Send a message to an active agent chat and get the full response text back. Use the chatId from start_agent_chat. The agent remembers full context from previous messages in the same chat.",
      shape: SendAgentMessageInput.shape,
      approval: "none",
      missing: (chatId) => noActiveChat(chatId, " Use start_agent_chat first."),
      run: async (input, handle, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const { userId } = ctx.identity;
        const client = chatHandleScope(ctx.identity);
        const turn = await store().claimTurn(userId, client, input.chatId);
        if (!turn) {
          return textResult(`The previous reply is still in progress.${continuationNote(handle)}`);
        }
        try {
          return await sendAgentTurn({
            handle,
            chatId: input.chatId,
            message: input.message,
            io: streamIO(environment, handle.sessionId, canTriggerTask(ctx, environment.type)),
            persist: (next) => store().put(userId, client, input.chatId, next),
            maxWaitMs: options.maxWaitMs,
            pollIntervalMs: options.pollIntervalMs,
            signal: ctx.signal,
          });
        } finally {
          await store().releaseTurn(userId, client, input.chatId, turn);
        }
      },
    }),
    defineHandleTool({
      name: "close_agent_chat",
      title: "Close Agent Chat",
      description:
        "Close an agent chat conversation. The agent exits its loop gracefully. Without this, the agent will close on its own when its idle timeout expires.",
      shape: CloseAgentChatInput.shape,
      approval: "none",
      missing: (chatId) => noActiveChat(chatId),
      run: async (input, handle, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (environment && handle.runId) {
          await tryCatch(
            resolveSessionWithWriterFallback(environment.id, handle.sessionId).then(
              (session) =>
                session &&
                appendServerSessionRecord({
                  environment,
                  session,
                  addressingKey: canonicalSessionAddressingKey(session, handle.sessionId),
                  io: "in",
                  part: JSON.stringify({
                    kind: "message",
                    payload: { chatId: input.chatId, trigger: "close" },
                  }),
                })
            )
          );
        }

        await store().delete(ctx.identity.userId, chatHandleScope(ctx.identity), input.chatId);
        return textResult(`Chat ${input.chatId} closed.`);
      },
    }),
  ];
}

export const agentChatTools = createAgentChatTools();

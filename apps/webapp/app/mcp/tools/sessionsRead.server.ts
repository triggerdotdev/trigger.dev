import type { ClickHouse } from "@internal/clickhouse";
import { tryCatch } from "@trigger.dev/core/utils";
import { readTranscriptTrailer, TRANSCRIPT_TRAILER_BYTES } from "@trigger.dev/core/v3";
import { $replica } from "~/db.server";
import { playgroundPresenter } from "~/presenters/v3/PlaygroundPresenter.server";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { SessionPresenter } from "~/presenters/v3/SessionPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { isTranscriptNotFound } from "~/services/realtime/transcriptDownload.server";
import { readTranscriptPageRanged } from "~/services/realtime/transcriptPage.server";
import { readSessionTranscriptSeed } from "~/services/realtime/transcriptSeed.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { ObjectVersionChangedError } from "~/v3/objectStoreClient.server";
import {
  downloadObjectRangeFromObjectStore,
  getObjectStoreClient,
  parseStorageUri,
} from "~/v3/objectStore.server";
import type { McpToolContext } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import {
  formatPlaygroundConversations,
  formatSessionDetails,
  formatSessionList,
  formatTranscriptPage,
  renderSessionId,
  sessionStatus,
} from "./format/sessions";
import { isEmptyObjectError } from "./format/objectStoreErrors";
import { withinDeadline } from "./runStreams.server";
import {
  ListPlaygroundConversationsInput,
  ListSessionsInput,
  ReadSessionTranscriptInput,
  SessionDetailsInput,
} from "./schemas/sessions";

const READ_ALLOWANCE_MS = 10_000;
const PLAYGROUND_CONVERSATIONS = 10;
const LEGACY_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const TRANSCRIPT_WINDOW_BYTES = 5 * 1024 * 1024;
const auth = { action: "read", subject: "sessions" } as const;

const SESSION_READ_FAILED = "Could not read sessions. Try again.";
const TIMED_OUT = "The read did not finish in time. Try again.";

function logSessionToolError(tool: string, error: unknown) {
  logger.error("MCP session tool failed", {
    tool,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

export type SessionsReadDeps = {
  clickhouse: (organizationId: string) => Promise<ClickHouse>;
  readAllowanceMs?: number;
  legacyTranscriptBytes?: number;
  transcriptWindowBytes?: number;
  now?: () => number;
};

type Location = { projectRef: string; envSlug: string };

type TranscriptMessages = Array<{ id: string; message: { role?: unknown; parts?: unknown } }>;

type TranscriptRead =
  | {
      kind: "page";
      messages: TranscriptMessages;
      nextCursor: string | undefined;
      omitted?: { index: number; bytes: number; id?: string };
    }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "changed" }
  | { kind: "unknown-cursor" }
  | { kind: "too-large"; bytes: number };

async function snapshotTail(key: string, location: Location) {
  if (!getObjectStoreClient(parseStorageUri(key).protocol)) return undefined;
  const range = await downloadObjectRangeFromObjectStore(
    { dataType: "application/store", data: key },
    location,
    { suffixLength: TRANSCRIPT_TRAILER_BYTES }
  );
  return {
    totalSize: range.totalSize,
    etag: range.etag,
    trailer: readTranscriptTrailer(new TextDecoder().decode(range.bytes)),
  };
}

function withIds(messages: unknown[]): TranscriptMessages {
  return messages.flatMap((message) => {
    const id = (message as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0
      ? [{ id, message: message as TranscriptMessages[number]["message"] }]
      : [];
  });
}

export function createSessionsReadTools(deps: SessionsReadDeps): McpToolDefinition[] {
  const allowance = deps.readAllowanceMs ?? READ_ALLOWANCE_MS;
  const legacyLimit = deps.legacyTranscriptBytes ?? LEGACY_TRANSCRIPT_BYTES;
  const windowBytes = deps.transcriptWindowBytes ?? TRANSCRIPT_WINDOW_BYTES;
  const now = deps.now ?? Date.now;
  const startDeadline = () => now() + allowance;

  async function bounded<T>(
    tool: string,
    ctx: McpToolContext,
    deadline: number,
    read: (checkpoint: () => void) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    let stopped = false;
    const checkpoint = () => {
      if (!ctx.signal.aborted && now() < deadline) return;
      stopped = true;
      throw new Error("Read stopped at the deadline or on cancel");
    };
    const at = now();
    if (ctx.signal.aborted || at >= deadline) return { ok: false, error: TIMED_OUT };
    try {
      const value = await withinDeadline(
        read(checkpoint),
        Date.now() + (deadline - at),
        ctx.signal
      );
      return value === undefined || stopped ? { ok: false, error: TIMED_OUT } : { ok: true, value };
    } catch (error) {
      if (stopped) return { ok: false, error: TIMED_OUT };
      logSessionToolError(tool, error);
      return { ok: false, error: SESSION_READ_FAILED };
    }
  }

  return [
    defineReadTool({
      name: "list_sessions",
      title: "List Sessions",
      description:
        "List the sessions in the project environment, newest first, like the Sessions page in the dashboard. Filter by status, type, agent, externalId, tags and creation time. Returns up to 50 sessions per page with cursors for the older and newer pages, and the agents you can filter by.",
      shape: ListSessionsInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const list = await bounded("list_sessions", ctx, startDeadline(), async (checkpoint) => {
          const clickhouse = await deps.clickhouse(environment.organizationId);
          checkpoint();
          return new SessionListPresenter($replica, clickhouse).call(
            environment.organizationId,
            environment.id,
            {
              userId: ctx.identity.userId,
              projectId: environment.projectId,
              statuses: input.statuses,
              types: input.types,
              taskIdentifiers: input.taskIdentifiers,
              externalId: input.externalId,
              tags: input.tags,
              period: input.period,
              from: input.from ? Date.parse(input.from) : undefined,
              to: input.to ? Date.parse(input.to) : undefined,
              cursor: input.cursor,
              direction: input.direction,
              pageSize: input.limit,
              beforeRead: checkpoint,
            }
          );
        });
        if (!list.ok) return errorResult(list.error);

        return textResult(formatSessionList(list.value));
      },
    }),
    defineReadTool({
      name: "get_session_details",
      title: "Get Session Details",
      description:
        "Get one session, like its page in the dashboard: status, agent, type, externalId, tags, metadata, trigger config, timing, its current run, the runs behind it (newest 50) and the names of its side channels. Read a channel with read_session_channel and the saved conversation with read_session_transcript.",
      shape: SessionDetailsInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const deadline = startDeadline();
        const session = await bounded("get_session_details", ctx, deadline, (checkpoint) =>
          new SessionPresenter($replica).call({
            userId: ctx.identity.userId,
            environmentId: environment.id,
            sessionParam: input.sessionId,
            projectExternalRef: environment.project.externalRef,
            environmentSlug: environment.slug,
            readTranscript: false,
            beforeRead: checkpoint,
          })
        );
        if (!session.ok) return errorResult(session.error);
        if (!session.value) return errorResult("Session not found");
        const details = session.value;

        const channels = await bounded("get_session_details", ctx, deadline, async (checkpoint) => {
          const row = await resolveSessionByIdOrExternalId(
            $replica,
            environment.id,
            details.friendlyId
          );
          if (!row) return [];
          checkpoint();
          const stream = getRealtimeStreamInstance(environment, "v2", { session: row });
          if (!(stream instanceof S2RealtimeStreams)) return [];
          return stream.listSessionChannels(
            canonicalSessionAddressingKey(row, details.friendlyId),
            {
              beforeRead: checkpoint,
            }
          );
        });

        return textResult(
          formatSessionDetails(
            { ...details, status: sessionStatus(details, Date.now()) },
            channels.ok ? channels.value : undefined
          )
        );
      },
    }),
    defineReadTool({
      name: "read_session_transcript",
      title: "Read Session Transcript",
      description:
        "Read a session's saved conversation, the messages the dashboard shows on the session's Conversation tab: what the end user sent and what the agent answered. Pages go backward from the newest message; pass the returned cursor as `before` for earlier messages. Each message is cut at 4,000 characters and one call returns at most 40,000 characters. Sessions whose agent loads its history from its own store have no saved transcript.",
      shape: ReadSessionTranscriptInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const deadline = startDeadline();
        const found = await bounded("read_session_transcript", ctx, deadline, () =>
          resolveSessionByIdOrExternalId($replica, environment.id, input.sessionId)
        );
        if (!found.ok) return errorResult(found.error);
        const session = found.value;
        if (!session) return errorResult("Session not found");

        const location = {
          projectRef: environment.project.externalRef,
          envSlug: environment.slug,
        };
        const key = chatSnapshotStorageKey(session);
        const page = { limit: input.maxMessages, before: input.before };
        const read = await bounded(
          "read_session_transcript",
          ctx,
          deadline,
          async (checkpoint): Promise<TranscriptRead> => {
            const [tailError, tail] = await tryCatch(snapshotTail(key, location));
            if (tailError) {
              if (isTranscriptNotFound(tailError)) return { kind: "none" };
              if (isEmptyObjectError(tailError)) return { kind: "none" };
              throw tailError;
            }
            if (tail && tail.totalSize > legacyLimit) {
              const tooLarge = { kind: "too-large" as const, bytes: tail.totalSize };
              if (!tail.trailer || tail.trailer.footerLength > legacyLimit) return tooLarge;
              const [rangedError, ranged] = await tryCatch(
                readTranscriptPageRanged(key, location, {
                  ...page,
                  maxWindowBytes: windowBytes,
                  ifMatch: tail.etag,
                  beforeRead: checkpoint,
                })
              );
              if (rangedError instanceof ObjectVersionChangedError) return { kind: "changed" };
              if (rangedError) throw rangedError;
              if (ranged === "unsupported") return tooLarge;
              if (ranged.unknownCursor) return { kind: "unknown-cursor" };
              return {
                kind: "page",
                messages: withIds(ranged.messages),
                nextCursor: ranged.nextCursor,
                omitted: ranged.omitted,
              };
            }
            if (tail?.totalSize === 0) return { kind: "none" };
            const seed = await readSessionTranscriptSeed({
              session,
              ...location,
              ...page,
              bounds: {
                windowBytes,
                objectBytes: legacyLimit,
                ifMatch: tail?.etag,
                beforeRead: checkpoint,
              },
            });
            return seed.kind === "seed"
              ? { kind: "page", messages: seed.seed.messages, nextCursor: seed.seed.nextCursor }
              : seed;
          }
        );
        if (!read.ok) return errorResult(read.error);

        const label = renderSessionId(session.friendlyId);
        if (read.value.kind === "too-large") {
          return errorResult(
            `This session's saved transcript is ${read.value.bytes.toLocaleString("en-US")} bytes and is not stored in a form that can be read a page at a time, so it is too large to read here. Open the session in the dashboard.`
          );
        }
        if (read.value.kind === "unknown-cursor") {
          return errorResult(
            "No message in the saved transcript matches the cursor. Read again without before."
          );
        }
        if (read.value.kind === "changed") {
          return errorResult("The saved transcript changed while it was being read. Read again.");
        }
        if (read.value.kind === "failed") {
          logSessionToolError("read_session_transcript", "transcript read failed");
          return errorResult("Could not read the saved transcript. Try again.");
        }
        if (read.value.kind === "none") {
          return textResult(`Session ${label} has no saved transcript.`);
        }

        const { messages, nextCursor, omitted } = read.value;
        return textResult(formatTranscriptPage(label, messages, nextCursor, omitted));
      },
    }),
    defineReadTool({
      name: "list_playground_conversations",
      title: "List Playground Conversations",
      description:
        "List your own recent playground conversations with an agent, most recently updated first, like the conversation list on the agent's Playground page in the dashboard. Each shows its title, chat id and run. The chat id is the session's externalId, so you can pass it to get_session_details or read_session_transcript.",
      shape: ListPlaygroundConversationsInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const deadline = startDeadline();
        const agent = await bounded("list_playground_conversations", ctx, deadline, (checkpoint) =>
          playgroundPresenter.getAgent({
            environmentId: environment.id,
            environmentType: environment.type,
            agentSlug: input.agentSlug,
            beforeRead: checkpoint,
          })
        );
        if (!agent.ok) return errorResult(agent.error);
        if (!agent.value) return errorResult("Agent not found");

        const conversations = await bounded(
          "list_playground_conversations",
          ctx,
          deadline,
          (checkpoint) =>
            playgroundPresenter.getRecentConversations({
              environmentId: environment.id,
              agentSlug: input.agentSlug,
              userId: ctx.identity.userId,
              limit: input.limit ?? PLAYGROUND_CONVERSATIONS,
              beforeRead: checkpoint,
            })
        );
        if (!conversations.ok) return errorResult(conversations.error);

        return textResult(
          formatPlaygroundConversations(
            input.agentSlug,
            conversations.value,
            input.limit ?? PLAYGROUND_CONVERSATIONS
          )
        );
      },
    }),
  ];
}

export const sessionsReadTools = createSessionsReadTools({
  clickhouse: (organizationId) =>
    clickhouseFactory.getClickhouseForOrganization(organizationId, "standard"),
});

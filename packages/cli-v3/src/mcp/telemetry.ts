import { PostHog } from "posthog-node";
import { randomUUID } from "node:crypto";
import { VERSION } from "../version.js";
import { forgetKnownUser, getKnownUser, type KnownUser } from "../utilities/knownUser.js";
import { lookupUserId } from "../utilities/lookupUserId.js";
import {
  argKeys,
  createAnalytics,
  createPostHogSink,
  environmentTypeOf,
  isAnalyticsEnabled,
  type AnalyticsGroups,
  type AnalyticsSink,
} from "../utilities/productAnalytics.js";
import { POSTHOG_INGEST_HOST, POSTHOG_PROJECT_KEY } from "../consts.js";
import { serverMetadata } from "./config.js";
import { NO_CREDENTIALS } from "./projectLookup.js";
import type { McpContextOptions } from "./context.js";

/**
 * Analytics for the MCP server, sent straight from the CLI.
 *
 * Off when the user says so, by `--skip-telemetry` or TRIGGER_TELEMETRY_DISABLED (the same
 * variable the webapp honours). Tools that report anywhere are hidden while it is off, rather
 * than left to fail at call time.
 */
export function isTelemetryEnabled(options: McpContextOptions): boolean {
  return isAnalyticsEnabled(options.skipTelemetry);
}

// PostHog's per-tool MCP reports only read events carrying this value.
const MCP_ANALYTICS_SOURCE = "posthog_mcp_analytics";
const PROJECT_LOOKUP_TIMEOUT_MS = 2000;
const MAX_LOOKUPS = 50;
const PROJECT_REF = /^proj_[a-z0-9]+$/;

export type ProjectIds = { organizationId: string; projectId: string };

export type McpTelemetry = ReturnType<typeof createMcpTelemetry>;

/**
 * Product analytics for one MCP process: one long-lived client that flushes in small, quick
 * batches, because MCP clients kill stdio servers abruptly. Never throws and never waits.
 */
export function createMcpTelemetry(
  options: McpContextOptions,
  deps: {
    sink?: AnalyticsSink;
    lookupUserId?: () => Promise<KnownUser | undefined>;
    lookupProject?: (projectRef: string) => Promise<ProjectIds | typeof NO_CREDENTIALS | undefined>;
    projectLookupTimeoutMs?: number;
  } = {}
) {
  const sessionId = `mcps_${randomUUID()}`;
  const analytics = createAnalytics({
    enabled: isTelemetryEnabled(options),
    sink: deps.sink ?? createPostHogSink({ flushAt: 5, flushIntervalMs: 2000 }),
  });
  const lookup =
    deps.lookupUserId ?? (() => lookupUserId({ profile: options.profile, apiUrl: options.apiUrl }));
  let lookedUp: Promise<KnownUser | undefined> | undefined;
  // Bumped by reset(): a lookup that started before it must not be used.
  let epoch = 0;
  // A login that a tool completes later wins over the stored-login lookup.
  const userId = async () => {
    const known = getKnownUser();
    if (known) return known;
    const started = epoch;
    const user = await (lookedUp ??= lookup());
    return started === epoch ? user : undefined;
  };

  type Entry = { settled: boolean; groups?: AnalyticsGroups; waiters: Set<Waiter> };
  type Waiter = (groups: AnalyticsGroups | undefined) => void;
  const lookups = new Map<string, Entry>();
  const pending = new Set<Waiter>();
  let closed = false;
  // One reaction per lookup; each event only holds a waiter and a timer until it settles.
  const groupsFor = (ref: string) => {
    let entry = lookups.get(ref);
    if (!entry) {
      if (lookups.size >= MAX_LOOKUPS) return Promise.resolve(undefined);
      const created: Entry = { settled: false, waiters: new Set() };
      entry = created;
      lookups.set(ref, created);
      void (async () => {
        const ids = await deps.lookupProject?.(ref);
        if (ids === NO_CREDENTIALS) {
          if (lookups.get(ref) === created) lookups.delete(ref);
          return undefined;
        }
        return ids ? { organization: ids.organizationId, project: ids.projectId } : undefined;
      })()
        .catch(() => undefined)
        .then((groups) => {
          created.settled = true;
          created.groups = groups;
          for (const waiter of [...created.waiters]) waiter(groups);
        });
    }
    if (entry.settled) return Promise.resolve(entry.groups);
    if (closed) return Promise.resolve(undefined);
    const waiting = entry.waiters;
    return new Promise<AnalyticsGroups | undefined>((resolve) => {
      const finish: Waiter = (groups) => {
        clearTimeout(timer);
        waiting.delete(finish);
        pending.delete(finish);
        resolve(groups);
      };
      const timer = setTimeout(
        () => finish(undefined),
        deps.projectLookupTimeoutMs ?? PROJECT_LOOKUP_TIMEOUT_MS
      );
      timer.unref();
      waiting.add(finish);
      pending.add(finish);
    });
  };
  let seq = 0;
  let client: { name?: string; version?: string } | undefined;
  let startedAt: Date | undefined;
  let initialize: "none" | "pending" | "sent" = "none";
  const ids = { $session_id: sessionId, $mcp_session_id: sessionId };
  const server = {
    $mcp_server_name: serverMetadata.name,
    $mcp_server_version: serverMetadata.version,
    $mcp_source: MCP_ANALYTICS_SOURCE,
  };

  // Once per process: at the handshake, or with the first event that has a Cloud account.
  const sendInitialize = () => {
    if (!startedAt || initialize !== "none") return;
    initialize = "pending";
    const attempt = epoch;
    void analytics
      .capture(
        {
          event: "$mcp_initialize",
          timestamp: startedAt,
          properties: {
            ...ids,
            $mcp_client_name: client?.name,
            $mcp_client_version: client?.version,
            ...server,
            surface: "local",
            cliVersion: VERSION,
          },
        },
        userId,
        undefined,
        () => {
          if (attempt !== epoch) return false;
          initialize = "sent";
          return true;
        }
      )
      .then((sent) => {
        // A reset already released this attempt; its outcome belongs to the old profile.
        if (!sent && attempt === epoch) initialize = "none";
      });
  };

  return {
    sessionId,
    sessionStarted(info?: { name?: string; version?: string }) {
      const bound = (value: unknown) =>
        typeof value === "string" ? value.slice(0, 100) : undefined;
      client = { name: bound(info?.name), version: bound(info?.version) };
      startedAt = new Date();
      sendInitialize();
    },
    toolCalled(call: {
      tool: string;
      ok: boolean;
      durationMs: number;
      input: unknown;
      resolvedProjectRef?: string;
    }) {
      seq += 1;
      sendInitialize();
      const input = call.input as { projectRef?: unknown } | null;
      // The ref the tool actually used; an empty input ref counts as absent there too.
      const given =
        call.resolvedProjectRef ??
        (typeof input?.projectRef === "string" ? input.projectRef : undefined);
      const ref = given && PROJECT_REF.test(given) ? given : undefined;
      void analytics.capture(
        {
          event: "$mcp_tool_call",
          properties: {
            ...ids,
            $mcp_tool_name: call.tool,
            $mcp_duration_ms: call.durationMs,
            $mcp_is_error: !call.ok,
            ...server,
            $mcp_client_name: client?.name,
            $mcp_client_version: client?.version,
            surface: "local",
            outcome: call.ok ? "ok" : "error",
            argKeys: argKeys(call.input),
            seq,
            environmentType: environmentTypeOf(call.input),
            cliVersion: VERSION,
          },
        },
        userId,
        ref ? () => groupsFor(ref) : undefined
      );
    },
    // After a profile switch the old account's lookups no longer apply.
    reset: () => {
      epoch += 1;
      if (initialize === "pending") initialize = "none";
      forgetKnownUser();
      lookups.clear();
      lookedUp = undefined;
    },
    shutdown: (timeoutMs: number) => {
      closed = true;
      for (const waiter of [...pending]) waiter(undefined);
      return analytics.shutdown(timeoutMs);
    },
  };
}

export type FeedbackEvent = {
  userId: string;
  message: string;
  toolName?: string;
  projectRef?: string;
  cliVersion: string;
};

/**
 * Captures a feedback report and waits for it to leave the machine. A stdio MCP server dies
 * whenever its client closes it, so an unflushed report would be lost while the agent had
 * already been told it was sent.
 */
export async function captureFeedback(event: FeedbackEvent): Promise<void> {
  // A client per report, shut down straight after. flush() resolves without delivering
  // anything - only shutdown() drains the queue - and reports are rare enough that the
  // extra client costs nothing next to reporting success for something never sent.
  const posthog = new PostHog(POSTHOG_PROJECT_KEY, { host: POSTHOG_INGEST_HOST });

  // shutdown() swallows fetch failures - it logs them and resolves - so without this the tool
  // would report a delivery that never happened. The error event is the only signal.
  let deliveryError: Error | undefined;
  posthog.on("error", (error: unknown) => {
    deliveryError ??= error instanceof Error ? error : new Error(String(error));
  });

  posthog.capture({
    distinctId: event.userId,
    event: "mcp_feedback_submitted",
    properties: {
      message: event.message,
      toolName: event.toolName,
      projectRef: event.projectRef,
      cliVersion: event.cliVersion,
      source: "mcp",
    },
    groups: event.projectRef ? { project: event.projectRef } : undefined,
  });

  await posthog.shutdown();

  if (deliveryError) {
    throw deliveryError;
  }
}

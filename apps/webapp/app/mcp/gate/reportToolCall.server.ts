import { setTimeout as sleep } from "node:timers/promises";
import {
  newMcpSessionId,
  sessionStartedProperties,
  type McpClientIdentity,
} from "../sessionTelemetry";
import {
  SESSION_RESOLVE_TIMEOUT_MS,
  telemetryClientKey,
  type TelemetrySessionStore,
} from "../telemetrySessionStore";

export type ToolCall = {
  userId: string;
  organizationId?: string;
  projectId?: string;
  properties: Record<string, unknown>;
  // Set for modern-era calls without a session id; they are grouped by inactivity.
  stitch?: { client?: McpClientIdentity; userAgent?: string };
};

export type TelemetryEvent = {
  event: "$mcp_initialize" | "$mcp_tool_call";
  properties: Record<string, unknown>;
  timestamp: Date;
};

export function assembleStitchedEvents(input: {
  call: ToolCall;
  session?: { id: string; started: boolean };
  at: Date;
}): TelemetryEvent[] {
  const { call, session, at } = input;
  if (!session) return [{ event: "$mcp_tool_call", properties: call.properties, timestamp: at }];

  const toolCall: TelemetryEvent = {
    event: "$mcp_tool_call",
    properties: {
      ...call.properties,
      $session_id: session.id,
      $mcp_session_id: session.id,
      sessionSource: "inactivity",
    },
    timestamp: at,
  };
  if (!session.started) return [toolCall];

  const initialize: TelemetryEvent = {
    event: "$mcp_initialize",
    properties: sessionStartedProperties({
      mcpSessionId: session.id,
      clientName: call.stitch?.client?.clientName,
      clientVersion: call.stitch?.client?.clientVersion,
      protocolVersion: call.stitch?.client?.protocolVersion,
      userAgent: call.stitch?.userAgent,
      sessionSource: "inactivity",
    }),
    timestamp: new Date(at.getTime() - 1),
  };
  return [initialize, toolCall];
}

export function createToolCallReporter(deps: {
  enabled: () => boolean;
  store: () => TelemetrySessionStore;
  send: (call: ToolCall, event: TelemetryEvent) => void;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
}) {
  return async (call: ToolCall): Promise<void> => {
    if (!deps.enabled()) return;
    const at = (deps.now ?? (() => new Date()))();

    let session: { id: string; started: boolean } | undefined;
    if (call.stitch) {
      const key = telemetryClientKey({
        clientName: call.stitch.client?.clientName,
        userAgent: call.stitch.userAgent,
      });
      const resolved = (async () =>
        deps.store().resolve(call.userId, key, (deps.newId ?? newMcpSessionId)()))().catch(
        () => undefined
      );
      session = await Promise.race([
        resolved,
        sleep(deps.timeoutMs ?? SESSION_RESOLVE_TIMEOUT_MS, undefined, { ref: false }),
      ]);
    }

    for (const event of assembleStitchedEvents({ call, session, at })) deps.send(call, event);
  };
}

// Loaded on first use so importing the gate doesn't parse env; never throws into a request.
export type ReportToolCall = (call: ToolCall) => void;

export function reportToolCall(call: ToolCall) {
  void (async () => {
    const [{ telemetry }, { telemetrySessionStore }] = await Promise.all([
      import("~/services/telemetry.server"),
      import("../telemetrySessionStore.server"),
    ]);
    await createToolCallReporter({
      enabled: () => telemetry.mcp.isEnabled(),
      store: telemetrySessionStore,
      send: (c, e) => {
        const base = {
          userId: c.userId,
          eventProperties: e.properties,
          timestamp: e.timestamp,
        };
        if (e.event === "$mcp_initialize") telemetry.mcp.sessionStarted(base);
        else
          telemetry.mcp.toolCalled({
            ...base,
            organizationId: c.organizationId,
            projectId: c.projectId,
          });
      },
    })(call);
  })().catch(() => {});
}

export function reportSessionStarted(call: {
  userId: string;
  properties: Record<string, unknown>;
}) {
  void import("~/services/telemetry.server")
    .then(({ telemetry }) =>
      telemetry.mcp.sessionStarted({ userId: call.userId, eventProperties: call.properties })
    )
    .catch(() => {});
}

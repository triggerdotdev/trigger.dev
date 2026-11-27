import { CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";

const SESSION_PATTERN = /^mcps_[0-9a-f-]{36}$/;

export const MCP_SESSION_HEADER = "mcp-session-id";

export function newMcpSessionId() {
  return `mcps_${randomUUID()}`;
}

export function sanitizeMcpSessionId(value: string | null | undefined) {
  return value && SESSION_PATTERN.test(value) ? value : undefined;
}

// Names only, never values.
function argKeys(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}

function shortString(value: unknown, max = 100) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function clientInfoFromInitialize(body: unknown) {
  const info = (body as { params?: { clientInfo?: Record<string, unknown> } } | undefined)?.params
    ?.clientInfo;
  return { clientName: shortString(info?.name), clientVersion: shortString(info?.version) };
}

export function protocolVersionFromInitialize(body: unknown) {
  return shortString(
    (body as { params?: { protocolVersion?: unknown } } | undefined)?.params?.protocolVersion
  );
}

// The header is trusted only in the legacy era; modern calls are always grouped server-side.
export function sessionHandling(era: string | undefined, headers: Headers) {
  if (era === "modern") return { mcpSessionId: undefined, stitch: true };
  return { mcpSessionId: sanitizeMcpSessionId(headers.get(MCP_SESSION_HEADER)), stitch: false };
}

export type McpClientIdentity = {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
};

// The SDK types the envelope as {}, so read it defensively.
export function clientIdentityFromEnvelope(envelope: unknown): McpClientIdentity {
  const meta = (typeof envelope === "object" && envelope !== null ? envelope : {}) as Record<
    string,
    unknown
  >;
  const info = meta[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | null;
  return {
    clientName: shortString(info?.name),
    clientVersion: shortString(info?.version),
    protocolVersion: shortString(meta[PROTOCOL_VERSION_META_KEY]),
  };
}

export const MCP_SERVER_INFO = { name: "trigger.dev", version: "1.0.0" };

// PostHog's per-tool MCP reports only read events carrying this value.
const MCP_ANALYTICS_SOURCE = "posthog_mcp_analytics";

export function userAgentOf(headers: Headers) {
  return shortString(headers.get("user-agent") || undefined, 200);
}

function sessionIds(mcpSessionId: string | undefined) {
  return { $session_id: mcpSessionId, $mcp_session_id: mcpSessionId };
}

export function sessionStartedProperties(input: {
  mcpSessionId: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  userAgent?: string;
  sessionSource?: "handshake" | "inactivity";
}) {
  return {
    ...sessionIds(input.mcpSessionId),
    sessionSource: input.sessionSource ?? "handshake",
    $mcp_client_name: input.clientName,
    $mcp_client_version: input.clientVersion,
    $mcp_server_name: MCP_SERVER_INFO.name,
    $mcp_server_version: MCP_SERVER_INFO.version,
    $mcp_source: MCP_ANALYTICS_SOURCE,
    $mcp_protocol_version: input.protocolVersion,
    $mcp_client_user_agent: input.userAgent,
    surface: "remote",
  };
}

export function toolCalledProperties(input: {
  mcpSessionId?: string;
  tool: string;
  outcome: string;
  durationMs: number;
  args: unknown;
  environmentType?: string;
  denyReason?: string;
  tokenKind: string;
  clientId?: string;
  userAgent?: string;
  client?: McpClientIdentity;
}) {
  return {
    ...sessionIds(input.mcpSessionId),
    $mcp_tool_name: input.tool,
    $mcp_duration_ms: input.durationMs,
    $mcp_is_error: input.outcome === "error",
    $mcp_server_name: MCP_SERVER_INFO.name,
    $mcp_server_version: MCP_SERVER_INFO.version,
    $mcp_source: MCP_ANALYTICS_SOURCE,
    $mcp_client_name: input.client?.clientName,
    $mcp_client_version: input.client?.clientVersion,
    $mcp_protocol_version: input.client?.protocolVersion,
    $mcp_client_user_agent: input.userAgent,
    surface: "remote",
    sessionSource: input.mcpSessionId ? "handshake" : undefined,
    outcome: input.outcome,
    argKeys: argKeys(input.args),
    environmentType: input.environmentType,
    denyReason: input.denyReason,
    tokenKind: input.tokenKind,
    clientId: input.clientId,
  };
}

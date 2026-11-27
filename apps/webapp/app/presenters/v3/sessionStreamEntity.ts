import { safeJsonParse } from "~/utils/json";

type SessionStreamEntityObject = {
  sessionId: string;
  channel: string | undefined;
  io: "out" | "in";
  metadata: Record<string, unknown> | undefined;
};

/**
 * Extracts `session-stream` span entity fields.
 *
 * Prefers unsplit `session`, `channel`, and `io` span properties because
 * session keys may contain `:` (e.g. `clerk:user_123:v2`) and `"in"` stream
 * entity IDs carry a leading `runId:` prefix.
 */
export function extractSessionStreamEntity({
  entityId,
  entityMetadata,
  properties,
}: {
  entityId?: string | null;
  entityMetadata?: string | null;
  properties?: unknown;
}): SessionStreamEntityObject | null {
  const props =
    properties && typeof properties === "object"
      ? (properties as Record<string, unknown>)
      : undefined;

  const propSessionId =
    typeof props?.session === "string" && props.session.length > 0 ? props.session : undefined;
  const propIo = props?.io === "out" || props?.io === "in" ? props.io : undefined;
  const propChannel =
    typeof props?.channel === "string" && props.channel.length > 0 ? props.channel : undefined;

  let sessionId = propSessionId;
  let io: string | undefined = propIo;
  let channel = propChannel;

  if (!sessionId || !io) {
    if (!entityId) {
      return null;
    }

    const parts = entityId.split(":");
    const parsedIo = parts.at(-1);
    const parsedChannel = parts.at(-2) ?? "";
    const parsedSessionId =
      parsedIo === "in" && parts.length >= 4 && parts[0]?.startsWith("run_")
        ? parts.slice(1, -2).join(":")
        : parts.slice(0, -2).join(":");

    sessionId = sessionId ?? (parsedSessionId.length > 0 ? parsedSessionId : undefined);
    io = io ?? parsedIo;
    channel = channel ?? (parsedChannel.length > 0 ? parsedChannel : undefined);
  }

  if (!sessionId || (io !== "out" && io !== "in")) {
    return null;
  }

  const metadata = entityMetadata
    ? (safeJsonParse(entityMetadata) as Record<string, unknown> | undefined)
    : undefined;

  return {
    sessionId,
    channel,
    io,
    metadata,
  };
}

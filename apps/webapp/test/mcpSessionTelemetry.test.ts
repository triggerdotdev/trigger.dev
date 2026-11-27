import { describe, expect, it } from "vitest";
import {
  clientInfoFromInitialize,
  newMcpSessionId,
  sanitizeMcpSessionId,
  sessionHandling,
  toolCalledProperties,
  userAgentOf,
} from "~/mcp/sessionTelemetry";

const UUID = "3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b";

describe("sanitizeMcpSessionId", () => {
  it.each([
    ["minted id", newMcpSessionId(), true],
    ["wrong prefix", UUID, false],
    ["injected suffix", `mcps_${UUID}\nx`, false],
    ["too short", "mcps_abc", false],
    ["missing", undefined, false],
  ])("%s", (_name, value, kept) => {
    expect(sanitizeMcpSessionId(value)).toBe(kept ? value : undefined);
  });
});

describe("sessionHandling", () => {
  const valid = newMcpSessionId();
  const headers = new Headers({ "mcp-session-id": valid });

  // Catches: a modern call trusting a client-sent session id instead of grouping server-side.
  it("honours the header only in the legacy era", () => {
    expect(sessionHandling("legacy", headers)).toEqual({ mcpSessionId: valid, stitch: false });
    expect(sessionHandling("modern", headers)).toEqual({ mcpSessionId: undefined, stitch: true });
  });
});

describe("toolCalledProperties", () => {
  // Catches: argument values leaking into the event, or unsorted keys.
  it("carries sorted argument names and never their values", () => {
    const props = toolCalledProperties({
      tool: "query",
      outcome: "ok",
      durationMs: 12,
      args: { query: "SELECT secret", period: "7d", skipped: undefined },
      tokenKind: "pat",
    });

    expect(props.argKeys).toEqual(["period", "query"]);
    expect(JSON.stringify(props)).not.toContain("SELECT secret");
    expect(props.surface).toBe("remote");
    expect(props.$mcp_source).toBe("posthog_mcp_analytics");
  });

  // Catches: the modern-era client identity not reaching the event.
  it("maps the client identity, and omits it without one", () => {
    const base = { tool: "query", outcome: "ok", durationMs: 1, args: {}, tokenKind: "pat" };
    const client = {
      clientName: "claude-code",
      clientVersion: "2.1",
      protocolVersion: "2026-07-28",
    };

    expect(toolCalledProperties({ ...base, client })).toMatchObject({
      $mcp_client_name: "claude-code",
      $mcp_client_version: "2.1",
      $mcp_protocol_version: "2026-07-28",
    });
    expect(toolCalledProperties(base)).toMatchObject({
      $mcp_client_name: undefined,
      $mcp_protocol_version: undefined,
    });
  });
});

describe("toolCalledProperties $mcp_is_error", () => {
  // Catches: counting denials and confirmations as errors.
  it.each([
    ["error", true],
    ["ok", false],
    ["denied", false],
    ["insufficient_scope", false],
    ["pending", false],
  ])("%s", (outcome, isError) => {
    const props = toolCalledProperties({
      tool: "query",
      outcome,
      durationMs: 1,
      args: {},
      tokenKind: "pat",
    });
    expect(props.$mcp_is_error).toBe(isError);
  });
});

describe("clientInfoFromInitialize", () => {
  it("reads the client name and version", () => {
    expect(
      clientInfoFromInitialize({ params: { clientInfo: { name: "claude-code", version: "2.1" } } })
    ).toEqual({ clientName: "claude-code", clientVersion: "2.1" });
    expect(clientInfoFromInitialize({ params: {} })).toEqual({
      clientName: undefined,
      clientVersion: undefined,
    });
  });
});

describe("userAgentOf", () => {
  it("drops an empty header and caps long ones", () => {
    expect(userAgentOf(new Headers({ "user-agent": "" }))).toBeUndefined();
    expect(userAgentOf(new Headers({ "user-agent": "a".repeat(300) }))).toHaveLength(200);
  });
});

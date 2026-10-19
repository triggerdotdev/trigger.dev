import { describe, expect, it } from "vitest";
import { detectAgent } from "./agent.js";

describe("detectAgent", () => {
  it("returns undefined when no agent env vars are set", () => {
    expect(detectAgent({ TERM: "xterm-256color", CI: "true" })).toBeUndefined();
  });

  it("detects agents from the env vars they set", () => {
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgent({ GEMINI_CLI: "1" })).toBe("gemini");
  });

  it("ignores agent env vars that are set but empty", () => {
    expect(detectAgent({ CLAUDECODE: "" })).toBeUndefined();
  });

  it("treats a dev session started by the Trigger.dev MCP server as an agent", () => {
    expect(detectAgent({ TRIGGER_MCP_SERVER: "1" })).toBe("trigger-mcp");
  });

  it("lets AI_AGENT name an agent we don't detect", () => {
    expect(detectAgent({ AI_AGENT: "MyAgent" })).toBe("myagent");
    expect(detectAgent({ AI_AGENT: "other", CLAUDECODE: "1" })).toBe("other");
  });
});

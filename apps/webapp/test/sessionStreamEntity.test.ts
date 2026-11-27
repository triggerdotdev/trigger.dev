import { describe, expect, it } from "vitest";
import { extractSessionStreamEntity } from "~/presenters/v3/sessionStreamEntity";

describe("extractSessionStreamEntity", () => {
  it("preserves colons in session keys for out spans using properties", () => {
    expect(
      extractSessionStreamEntity({
        entityId: "clerk:user_123:v2::out",
        properties: {
          session: "clerk:user_123:v2",
          io: "out",
        },
      })
    ).toEqual({
      sessionId: "clerk:user_123:v2",
      channel: undefined,
      io: "out",
      metadata: undefined,
    });
  });

  it("extracts channel and metadata when session key contains colons", () => {
    expect(
      extractSessionStreamEntity({
        entityId: "org:42:thread:9:tokens:out",
        entityMetadata: JSON.stringify({ model: "gpt-4o" }),
        properties: {
          session: "org:42:thread:9",
          channel: "tokens",
          io: "out",
        },
      })
    ).toEqual({
      sessionId: "org:42:thread:9",
      channel: "tokens",
      io: "out",
      metadata: { model: "gpt-4o" },
    });
  });

  it("does not include the runId prefix in sessionId for in spans", () => {
    expect(
      extractSessionStreamEntity({
        entityId: "run_abc123:clerk:user_123:v2:approvals:in",
        properties: {
          session: "clerk:user_123:v2",
          channel: "approvals",
          io: "in",
        },
      })
    ).toEqual({
      sessionId: "clerk:user_123:v2",
      channel: "approvals",
      io: "in",
      metadata: undefined,
    });
  });

  it("preserves session keys starting with run_ when properties are present", () => {
    expect(
      extractSessionStreamEntity({
        entityId: "run_outer:run_custom:session:1::in",
        properties: {
          session: "run_custom:session:1",
          io: "in",
        },
      })
    ).toEqual({
      sessionId: "run_custom:session:1",
      channel: undefined,
      io: "in",
      metadata: undefined,
    });
  });

  it("resolves session stream fields from properties when entityId is absent", () => {
    expect(
      extractSessionStreamEntity({
        entityId: undefined,
        properties: {
          session: "user:abc:def",
          io: "in",
        },
      })
    ).toEqual({
      sessionId: "user:abc:def",
      channel: undefined,
      io: "in",
      metadata: undefined,
    });
  });

  it("falls back to entityId parsing when properties are missing", () => {
    expect(
      extractSessionStreamEntity({
        entityId: "clerk:user_123:v2::out",
      })
    ).toEqual({
      sessionId: "clerk:user_123:v2",
      channel: undefined,
      io: "out",
      metadata: undefined,
    });

    expect(
      extractSessionStreamEntity({
        entityId: "run_abc123:clerk:user_123:v2:side:in",
      })
    ).toEqual({
      sessionId: "clerk:user_123:v2",
      channel: "side",
      io: "in",
      metadata: undefined,
    });
  });

  it("returns null for missing ids or invalid io directions", () => {
    expect(extractSessionStreamEntity({ entityId: undefined })).toBeNull();
    expect(extractSessionStreamEntity({ entityId: "sess_1::invalid" })).toBeNull();
    expect(extractSessionStreamEntity({ entityId: ":channel:out" })).toBeNull();
  });
});

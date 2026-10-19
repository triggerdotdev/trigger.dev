import { buildJwtAbility, withActionAliases } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import { sessionCreateAuthorizationOutcome } from "~/services/sessionAuthorizationTelemetry.server";

describe("session creation authorization observation", () => {
  it.each([
    [["write:sessions"], "missing_task_trigger"],
    [["write:sessions:chat-1"], "missing_both"],
    [["trigger:tasks:chat"], "missing_session_write"],
    [["write:tasks:chat"], "missing_session_write"],
    [["write:sessions", "trigger:tasks:chat"], "both_allowed"],
    [["write:sessions", "trigger:tasks:other"], "missing_task_trigger"],
    [["write:sessions", "write:tasks:chat"], "both_allowed"],
    [["write:sessions", "trigger:tasks"], "both_allowed"],
    [["admin"], "both_allowed"],
    [["write:all"], "both_allowed"],
  ] as const)("classifies %j as %s", (scopes, expected) => {
    expect(
      sessionCreateAuthorizationOutcome(withActionAliases(buildJwtAbility([...scopes])), "chat")
    ).toBe(expected);
  });

  it.each(["chat-1", "session_123"])(
    "requires a matching task even with write access to session %s",
    (sessionId) => {
      const ability = withActionAliases(
        buildJwtAbility([`write:sessions:${sessionId}`, "trigger:tasks:chat"])
      );
      expect(sessionCreateAuthorizationOutcome(ability, "chat", [sessionId])).toBe("both_allowed");
      expect(sessionCreateAuthorizationOutcome(ability, "other", [sessionId])).toBe(
        "missing_task_trigger"
      );
      expect(sessionCreateAuthorizationOutcome(ability, "chat", ["other-session"])).toBe(
        "missing_session_write"
      );
    }
  );
});

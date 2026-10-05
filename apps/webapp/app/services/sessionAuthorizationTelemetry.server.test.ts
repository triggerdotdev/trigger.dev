import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { buildJwtAbility, withActionAliases } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import {
  recordSessionCreateAuthorization,
  sessionCreateAuthorizationOutcome,
} from "~/services/sessionAuthorizationTelemetry.server";

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

  it("attributes only would-deny events without exporting the credential or task", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    const credential = `tr_prod_sk_${"a".repeat(24)}`;
    const request = new Request("https://example.com/api/v1/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ taskIdentifier: "requested-task" }),
    });
    const environment = {
      id: "env-1",
      organizationId: "org-1",
      projectId: "project-1",
      type: "PRODUCTION" as const,
    };

    try {
      recordSessionCreateAuthorization(
        withActionAliases(buildJwtAbility(["write:tasks:chat"])),
        { taskIdentifier: "chat" },
        request,
        environment
      );
      recordSessionCreateAuthorization(
        buildJwtAbility(["admin"]),
        { taskIdentifier: "chat" },
        request,
        environment
      );
      recordSessionCreateAuthorization(
        withActionAliases(buildJwtAbility(["write:sessions", "trigger:tasks:requested-task"])),
        { taskIdentifier: "stored-task" },
        request,
        environment
      );
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans[1].attributes["session.authorization.outcome"]).toBe("missing_task_trigger");
      expect(spans[0].name).toBe("session.create.authorization_would_deny");
      expect(spans[0].attributes).toMatchObject({
        forceRecording: true,
        "$trigger.org.id": "org-1",
        "$trigger.project.id": "project-1",
        "$trigger.env.id": "env-1",
        "session.authorization.credential_kind": "additional_api_key",
        "session.authorization.outcome": "missing_session_write",
      });
      expect(JSON.stringify(spans[0].attributes)).not.toContain(credential);
      expect(Object.values(spans[0].attributes)).not.toContain("chat");
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  });
});

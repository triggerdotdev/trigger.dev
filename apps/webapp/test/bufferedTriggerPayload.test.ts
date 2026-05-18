import { describe, expect, it } from "vitest";
import { buildBufferedTriggerPayload } from "~/v3/mollifier/bufferedTriggerPayload.server";

describe("buildBufferedTriggerPayload", () => {
  const baseInput = {
    runFriendlyId: "run_abc",
    taskId: "my-task",
    envId: "env_1",
    envType: "DEVELOPMENT",
    envSlug: "dev",
    orgId: "org_1",
    orgSlug: "acme",
    projectId: "proj_db_id",
    projectRef: "proj_xyz",
    body: { payload: { hello: "world" }, options: { tags: ["t1"] } } as any,
    idempotencyKey: null,
    idempotencyKeyExpiresAt: null,
    tags: ["t1"],
    parentRunFriendlyId: null,
    traceContext: { traceparent: "00-abc-def-01" },
    triggerSource: "api" as const,
    triggerAction: "trigger" as const,
    serviceOptions: {} as any,
    createdAt: new Date("2026-05-13T09:00:00.000Z"),
  };

  it("captures all routing identifiers without losing data", () => {
    const payload = buildBufferedTriggerPayload(baseInput);

    expect(payload.runFriendlyId).toBe("run_abc");
    expect(payload.envId).toBe("env_1");
    expect(payload.envType).toBe("DEVELOPMENT");
    expect(payload.envSlug).toBe("dev");
    expect(payload.orgId).toBe("org_1");
    expect(payload.orgSlug).toBe("acme");
    expect(payload.projectId).toBe("proj_db_id");
    expect(payload.projectRef).toBe("proj_xyz");
    expect(payload.taskId).toBe("my-task");
  });

  it("serialises idempotencyKeyExpiresAt to ISO string only when key is present", () => {
    const withKey = buildBufferedTriggerPayload({
      ...baseInput,
      idempotencyKey: "ik_1",
      idempotencyKeyExpiresAt: new Date("2026-05-13T10:00:00.000Z"),
    });
    expect(withKey.idempotencyKey).toBe("ik_1");
    expect(withKey.idempotencyKeyExpiresAt).toBe("2026-05-13T10:00:00.000Z");

    const noKey = buildBufferedTriggerPayload(baseInput);
    expect(noKey.idempotencyKey).toBeNull();
    expect(noKey.idempotencyKeyExpiresAt).toBeNull();

    // Defensive: an expiresAt without an accompanying key is an impossible
    // idempotency state — drop the expiresAt rather than serialise it.
    const orphanExpiry = buildBufferedTriggerPayload({
      ...baseInput,
      idempotencyKey: null,
      idempotencyKeyExpiresAt: new Date("2026-05-13T10:00:00.000Z"),
    });
    expect(orphanExpiry.idempotencyKey).toBeNull();
    expect(orphanExpiry.idempotencyKeyExpiresAt).toBeNull();
  });

  it("preserves customer body byte-equivalent (drainer replay must match Postgres)", () => {
    const body = {
      payload: { quotes: 'a"b', newline: "x\ny", unicode: "🚀", nested: { n: 1 } },
      options: { tags: ["a"], maxAttempts: 3, machine: "small-1x" },
    } as any;
    const payload = buildBufferedTriggerPayload({ ...baseInput, body });
    expect(payload.body).toEqual(body);

    // JSON round-trip is the storage path; verify no information loss.
    const roundtripped = JSON.parse(JSON.stringify(payload.body));
    expect(roundtripped).toEqual(body);
  });

  it("createdAt is serialised to ISO 8601", () => {
    const payload = buildBufferedTriggerPayload(baseInput);
    expect(payload.createdAt).toBe("2026-05-13T09:00:00.000Z");
  });

  it("preserves traceContext (OTel continuity across buffer→drain boundary)", () => {
    const traceContext = { traceparent: "00-x-y-01", tracestate: "vendor=foo" };
    const payload = buildBufferedTriggerPayload({ ...baseInput, traceContext });
    expect(payload.traceContext).toEqual(traceContext);
  });

  it("nullable parentRunFriendlyId — present and absent", () => {
    expect(buildBufferedTriggerPayload(baseInput).parentRunFriendlyId).toBeNull();
    expect(
      buildBufferedTriggerPayload({ ...baseInput, parentRunFriendlyId: "run_parent" })
        .parentRunFriendlyId,
    ).toBe("run_parent");
  });
});

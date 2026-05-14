import type { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import type { TriggerTaskServiceOptions } from "~/v3/services/triggerTask.server";

// Canonical payload shape written to the mollifier buffer when the gate
// decides to mollify a trigger. Phase 1 ALSO calls engine.trigger directly
// (dual-write) so this is currently an audit/preview record. Phase 2 will
// make the buffer the primary write path: the drainer's handler will read
// this payload and replay it through engine.trigger to create the run in
// Postgres, and read-fallback endpoints will synthesise a Run view from it
// while it is still QUEUED.
//
// CONTRACT: this shape must contain everything needed for Phase 2's
// drainer-replay to reconstruct an equivalent engine.trigger call. Phase 1
// emits it to logs; Phase 2 will serialise it into Redis and rebuild it on
// the drain side. Keep it serialisable — no functions, no class instances.
export type BufferedTriggerPayload = {
  runFriendlyId: string;

  // Routing identifiers — let the drainer re-fetch full AuthenticatedEnvironment
  // at replay time rather than embedding it in the payload.
  envId: string;
  envType: string;
  envSlug: string;
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectRef: string;

  // Task identifier — looked up against the locked BackgroundWorkerTask
  // at replay time to recover task-defaults.
  taskId: string;

  // Customer-supplied trigger body (payload, options, context).
  body: TriggerTaskRequestBody;

  // Resolved values from upstream concerns. The drainer should NOT re-resolve
  // these — that would create a second idempotency-key check, etc.
  idempotencyKey: string | null;
  idempotencyKeyExpiresAt: string | null;
  tags: string[];

  // Parent/root linkage for nested triggers.
  parentRunFriendlyId: string | null;

  // Trace context — propagates the original triggering span across the
  // buffer→drain boundary so the run's lifecycle stays under one trace.
  traceContext: Record<string, unknown>;

  // Annotations + service options that influence routing/replay.
  triggerSource: string;
  triggerAction: string;
  serviceOptions: TriggerTaskServiceOptions;

  // Wall-clock instants relevant to the run.
  createdAt: string;
};

// Assemble the canonical payload from the inputs available at the point
// `evaluateGate` returns "mollify" in `RunEngineTriggerTaskService.call`.
// All fields must be derivable from data already in scope at that call site;
// nothing should require an extra DB lookup.
export function buildBufferedTriggerPayload(input: {
  runFriendlyId: string;
  taskId: string;
  envId: string;
  envType: string;
  envSlug: string;
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectRef: string;
  body: TriggerTaskRequestBody;
  idempotencyKey: string | null;
  idempotencyKeyExpiresAt: Date | null;
  tags: string[];
  parentRunFriendlyId: string | null;
  traceContext: Record<string, unknown>;
  triggerSource: string;
  triggerAction: string;
  serviceOptions: TriggerTaskServiceOptions;
  createdAt: Date;
}): BufferedTriggerPayload {
  return {
    runFriendlyId: input.runFriendlyId,
    envId: input.envId,
    envType: input.envType,
    envSlug: input.envSlug,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    projectId: input.projectId,
    projectRef: input.projectRef,
    taskId: input.taskId,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    idempotencyKeyExpiresAt:
      input.idempotencyKey && input.idempotencyKeyExpiresAt
        ? input.idempotencyKeyExpiresAt.toISOString()
        : null,
    tags: input.tags,
    parentRunFriendlyId: input.parentRunFriendlyId,
    traceContext: input.traceContext,
    triggerSource: input.triggerSource,
    triggerAction: input.triggerAction,
    serviceOptions: input.serviceOptions,
    createdAt: input.createdAt.toISOString(),
  };
}

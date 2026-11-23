import type { ReadWebhookWaiterResult, WebhookEngine } from "@internal/webhook-engine";
import { z } from "zod";
import { webhookPrisma } from "~/db.server";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { organizationHasWebhooksAccess } from "~/v3/webhooksAccess.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleApproval } from "./defineWrite.server";
import { describeConditions, quoteForPreview } from "./format/webhooks";
import { EndpointWriteInput } from "./schemas/webhooks";
import {
  logWebhookToolError,
  WEBHOOKS_ENGINE_ERROR,
  WEBHOOKS_NOT_AVAILABLE,
  WEBHOOKS_NOT_ENABLED,
  webhooksAvailable,
  webhooksEngineEnabled,
} from "./webhooksRead.server";

type WaiterEngine = Pick<WebhookEngine, "readWaiter" | "cancelWaiter">;

const ENDPOINT_ID = /^wh_[a-z0-9]{1,64}$/;

const CancelWaiterInput = EndpointWriteInput.extend({
  waiterId: z
    .string()
    .regex(/^waitpoint_[a-z0-9]{1,64}$/)
    .describe("The waiter's id (waitpoint_...), as list_webhook_waiters prints it."),
});
type CancelWaiterArgs = z.output<typeof CancelWaiterInput>;

type FoundWaiter = Exclude<ReadWebhookWaiterResult, { state: "not_found" }>;

type CancelPlan =
  | { kind: "refuse"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "ready"; endpointId: string; state: FoundWaiter["state"]; preview: string };

const goneMessage = (args: CancelWaiterArgs) =>
  `Waiter ${args.waiterId} is no longer waiting on this endpoint: a delivery matched it, it timed out or it was cancelled earlier. Nothing was cancelled.`;

const RESUME_WITH_ERROR =
  "webhooks.waiter.wait returns { ok: false } and .unwrap() throws it. The runs are not cancelled; what they do next is up to the task code.";

function cancelPreview(waiterId: string, endpointFriendlyId: string, waiter: FoundWaiter): string {
  const endpoint = ENDPOINT_ID.test(endpointFriendlyId)
    ? endpointFriendlyId
    : quoteForPreview(endpointFriendlyId);
  const described = describeConditions(waiter);
  const match = described.match
    ? quoteForPreview(described.match)
    : "none (it waits on its own URL)";
  const filter = described.filter ? quoteForPreview(described.filter) : "none";
  const conditions = `Match: ${match}. Filter: ${filter}. Header values in conditions are hidden.`;

  if (waiter.state === "cancelled") {
    return [
      `Finish cancelling webhook waiter ${waiterId} on endpoint ${endpoint}. ${conditions}`,
      "1. The waiter was already removed by an earlier cancel.",
      `2. If its waitpoint has not been completed yet, it is completed with an error: WebhookWaiterCancelledError, "The webhook waiter was cancelled", and every run still waiting on it resumes with that error: ${RESUME_WITH_ERROR}`,
      "3. If its waitpoint was already completed, this changes nothing.",
      "4. No event is delivered to the task.",
      "5. It cannot be undone: to wait again, the task has to create a new waiter.",
    ].join("\n");
  }
  return [
    `Cancel webhook waiter ${waiterId} on endpoint ${endpoint}. ${conditions}`,
    "1. The waiter is removed, so no delivery can match it any more, and its slot is freed.",
    '2. Its waitpoint is completed with an error: WebhookWaiterCancelledError, "The webhook waiter was cancelled".',
    `3. Every run waiting on that waitpoint resumes with that error: ${RESUME_WITH_ERROR}`,
    "4. No event is delivered to the task.",
    "5. It cannot be undone: to wait again, the task has to create a new waiter.",
    "If a delivery claims the waiter first, nothing is cancelled: the waiter stays with that delivery, which resumes its runs with its event unless completing them fails.",
  ].join("\n");
}

async function buildPlan(
  engine: WaiterEngine,
  args: CancelWaiterArgs,
  environmentId: string
): Promise<CancelPlan> {
  const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
    where: webhookEndpointLookup(environmentId, args.endpointId),
    select: { id: true, friendlyId: true },
  });
  if (!endpoint) return { kind: "refuse", message: "Webhook endpoint not found" };

  const waiter = await engine
    .readWaiter({ environmentId, waiterId: args.waiterId, endpointId: endpoint.id })
    .catch((error: unknown) => {
      logWebhookToolError("cancel_webhook_waiter", error);
      return null;
    });
  if (!waiter) return { kind: "refuse", message: WEBHOOKS_ENGINE_ERROR };
  if (waiter.state === "not_found") return { kind: "gone", message: goneMessage(args) };
  return {
    kind: "ready",
    endpointId: endpoint.id,
    state: waiter.state,
    preview: cancelPreview(args.waiterId, endpoint.friendlyId, waiter),
  };
}

export function createWebhookWaiterWriteTools(
  engine: WaiterEngine,
  enabled: () => boolean
): McpToolDefinition[] {
  return [
    defineWriteTool({
      name: "cancel_webhook_waiter",
      title: "Cancel Webhook Waiter",
      description:
        "Cancel a waiter on a webhook endpoint (a waitpoint id from list_webhook_waiters). Its waitpoint is completed with a WebhookWaiterCancelledError, so the runs waiting on it resume with that error; no event is delivered and it cannot be undone.",
      shape: CancelWaiterInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "waitpoints" },
      confirm: {
        preview: async (args, subject) => {
          if (!subject?.environmentId) return { refuse: "Not authorized" };
          if (!enabled()) return { refuse: WEBHOOKS_NOT_ENABLED };
          if (!(await organizationHasWebhooksAccess(subject.organizationId))) {
            return { refuse: WEBHOOKS_NOT_AVAILABLE };
          }
          const plan = await buildPlan(engine, args, subject.environmentId);
          return plan.kind === "ready" ? plan.preview : { refuse: plan.message };
        },
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Not authorized");
        if (!enabled()) return errorResult(WEBHOOKS_NOT_ENABLED);
        if (!(await webhooksAvailable(ctx))) return errorResult(WEBHOOKS_NOT_AVAILABLE);

        const plan = await buildPlan(engine, input, environment.id);
        if (plan.kind === "refuse") return errorResult(plan.message);
        if (plan.kind === "gone") return textResult(plan.message);
        const stale = staleApproval(ctx, plan.preview);
        if (stale) return stale;

        const result = await engine
          .cancelWaiter({
            environmentId: environment.id,
            organizationId: environment.organizationId,
            waiterId: input.waiterId,
            endpointId: plan.endpointId,
          })
          .catch((error: unknown) => {
            logWebhookToolError("cancel_webhook_waiter", error);
            return null;
          });
        if (!result) {
          return errorResult(
            `Cancelling waiter ${input.waiterId} did not finish: the waiter may have been removed while its runs are still waiting. Call this tool again within an hour to complete it; after that its runs stay waiting until the waiter times out.`
          );
        }

        switch (result.outcome) {
          case "cancelled":
            return textResult(
              plan.state === "cancelled"
                ? `Waiter ${input.waiterId} had already been cancelled. Its waitpoint is now completed with WebhookWaiterCancelledError if it was not already, so any runs still waiting on it resume with that error.`
                : `Cancelled waiter ${input.waiterId}. Its waitpoint was completed with WebhookWaiterCancelledError, so the runs waiting on it resume with that error.`
            );
          case "too_late":
            return textResult(
              `A delivery claimed waiter ${input.waiterId} before it could be cancelled. Nothing was cancelled; that delivery resumes its runs with its event unless completing them fails.`
            );
          case "not_found":
            return textResult(
              `Waiter ${input.waiterId} was not found on this endpoint when cancelling. Nothing was cancelled.`
            );
        }
      },
    }),
  ];
}

export const webhooksWaiterWriteTools = createWebhookWaiterWriteTools(
  webhookEngine,
  webhooksEngineEnabled
);

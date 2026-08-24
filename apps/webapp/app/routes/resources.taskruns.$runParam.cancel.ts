import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

export const cancelSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  runParam: z.string(),
});

// Resolve the run's organization so the RBAC auth scope can resolve the
// user's role in it. The run may not be in Postgres yet (buffered during a
// burst), so fall back to the buffer entry's org.
async function resolveRunOrganizationId(runParam: string): Promise<string | null> {
  // Keyed by friendlyId only so the store routes to the owning run-ops DB.
  const run = await runStore.findRun(
    { friendlyId: runParam },
    { select: { runtimeEnvironmentId: true } }
  );
  if (run) {
    const env = await controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);
    if (env?.organizationId) {
      return env.organizationId;
    }
  }

  const buffer = getMollifierBuffer();
  const entry = buffer ? await buffer.getEntry(runParam) : null;
  if (entry?.orgId) {
    return entry.orgId;
  }

  // Replica lag with the buffer entry already drained: the run can exist in the
  // primary while both lookups above miss. Fall back to the primary so the RBAC
  // scope is never resolved without an org (which would let the role check run
  // unscoped under the RBAC plugin). Keyed by friendlyId so routing still applies.
  const primaryRun = await runStore.findRun(
    { friendlyId: runParam },
    { select: { runtimeEnvironmentId: true } },
    prisma
  );
  if (!primaryRun) {
    return null;
  }
  const primaryEnv = await controlPlaneResolver.resolveEnv(primaryRun.runtimeEnvironmentId);
  return primaryEnv?.organizationId ?? null;
}

export const action = dashboardAction(
  {
    params: ParamSchema,
    context: async (params) => {
      const organizationId = await resolveRunOrganizationId(params.runParam);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "runs" } },
  },
  async ({ request, params, user }) => {
    const { runParam } = params;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: cancelSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    try {
      // Keyed by friendlyId only so the store routes to the owning run-ops DB.
      // The project-scope + membership auth is a control-plane concern resolved
      // separately below; joining project/organization here is a cross-DB join
      // that returns nothing once the run lives in the run-ops DB.
      const cancelRunSelect = {
        id: true,
        engine: true,
        status: true,
        friendlyId: true,
        taskEventStore: true,
        createdAt: true,
        completedAt: true,
        projectId: true,
      };
      let taskRun = await runStore.findRun({ friendlyId: runParam }, { select: cancelRunSelect });
      if (!taskRun) {
        // Read-your-writes: a just-created run may not have replicated. Re-read the owning primary
        // before treating it as absent (mirrors resolveRunOrganizationId's primary fallback above).
        taskRun = await runStore.findRun(
          { friendlyId: runParam },
          { select: cancelRunSelect },
          prisma
        );
      }

      // Project-scope + membership auth is control-plane only — keyed by the
      // run's projectId. A miss is treated as not-found (mirrors the old where).
      const authorized = taskRun
        ? await prisma.project.findFirst({
            where: {
              id: taskRun.projectId,
              organization: { members: { some: { userId: user.id } } },
            },
            select: { id: true },
          })
        : null;

      if (taskRun && authorized) {
        const cancelRunService = new CancelTaskRunService();
        await cancelRunService.call(taskRun);
        return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Canceled run`);
      }

      // PG miss — try the mollifier buffer (customer cancelled a buffered run
      // during the burst window). Snapshot a `mark_cancelled` patch; the drainer
      // routes the run to `engine.createCancelledRun` on next pop.
      const buffer = getMollifierBuffer();
      const entry = buffer ? await buffer.getEntry(runParam) : null;
      if (!entry) {
        return json(submission.reply({ fieldErrors: { runParam: ["Run not found"] } }));
      }

      // Tenancy: verify the requesting user is a member of the buffered
      // run's org. The API path scopes by env id from the authenticated
      // request; the dashboard route uses org-membership because the URL
      // doesn't carry an envId.
      const member = await prisma.orgMember.findFirst({
        where: { userId: user.id, organizationId: entry.orgId },
        select: { id: true },
      });
      if (!member) {
        return json(submission.reply({ fieldErrors: { runParam: ["Run not found"] } }));
      }

      const result = await buffer!.mutateSnapshot(runParam, {
        type: "mark_cancelled",
        cancelledAt: new Date().toISOString(),
        cancelReason: "Canceled by user",
      });
      if (result === "applied_to_snapshot") {
        return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Canceled run`);
      }
      // "not_found" or "busy" — both indicate the drainer raced us between
      // the getEntry check above and mutateSnapshot. On "not_found" the
      // entry was just popped and the PG row is in flight; on "busy" the
      // drainer is mid-materialisation. Either way the customer should
      // retry — by then the PG row exists and the regular cancel path at
      // the top of this action takes over.
      return redirectWithErrorMessage(
        submission.value.redirectUrl,
        request,
        "Run is materialising — retry in a moment"
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Failed to cancel run", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
        return redirectWithErrorMessage(
          submission.value.redirectUrl,
          request,
          `Failed to cancel run, ${error.message}`
        );
      } else {
        logger.error("Failed to cancel run", { error });
        return redirectWithErrorMessage(
          submission.value.redirectUrl,
          request,
          `Failed to cancel run, ${JSON.stringify(error)}`
        );
      }
    }
  }
);

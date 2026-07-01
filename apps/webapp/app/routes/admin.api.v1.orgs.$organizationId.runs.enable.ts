import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { EnvironmentPauseSource } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";

import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const BodySchema = z.object({
  enable: z.boolean(),
});

/**
 * Enable or disable runs for an organization and pause/resume its non-dev environments.
 *
 * Billing-limit-paused environments are left unchanged when enabling or disabling runs;
 * they are reported in `skipped`, not counted in the update total. Other per-environment
 * failures are returned in `failures` (HTTP 409 when every environment fails, otherwise
 * HTTP 200).
 */
export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);
  const body = BodySchema.safeParse(await request.json());
  if (!body.success) {
    return json({ error: "Invalid request body", details: body.error }, { status: 400 });
  }

  const organization = await prisma.organization.update({
    where: {
      id: organizationId,
    },
    data: {
      runsEnabled: body.data.enable,
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  const environments = await prisma.runtimeEnvironment.findMany({
    where: {
      organizationId,
      type: {
        not: "DEVELOPMENT",
      },
    },
    include: {
      organization: true,
      project: true,
    },
  });

  const pauseEnvironmentService = new PauseEnvironmentService();
  const pauseAction = body.data.enable ? "resumed" : "paused";
  const failures: Array<{ environmentId: string; error: string }> = [];
  const skipped: Array<{ environmentId: string; reason: string }> = [];
  let updatedCount = 0;

  for (const environment of environments) {
    if (environment.pauseSource === EnvironmentPauseSource.BILLING_LIMIT) {
      if (!body.data.enable) {
        skipped.push({
          environmentId: environment.id,
          reason: "Environment is already paused due to billing limit and was left unchanged.",
        });
        continue;
      }

      skipped.push({
        environmentId: environment.id,
        reason:
          "Environment is paused due to billing limit and was left unchanged. Resolve the billing limit to resume.",
      });
      continue;
    }

    const result = await pauseEnvironmentService.call(
      { ...environment, organization },
      pauseAction
    );
    if (result.success) {
      updatedCount++;
    } else {
      failures.push({ environmentId: environment.id, error: result.error });
    }
  }

  const stateLabel = body.data.enable ? "enabled" : "disabled";
  const message = `${updatedCount} of ${environments.length} environments updated to ${stateLabel}`;

  if (failures.length > 0) {
    return json(
      {
        success: false,
        message,
        failures,
        ...(skipped.length > 0 ? { skipped } : {}),
      },
      { status: updatedCount === 0 ? 409 : 200 }
    );
  }

  return json({
    success: true,
    message,
    ...(skipped.length > 0 ? { skipped } : {}),
  });
}

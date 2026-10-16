import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { setOrgConcurrencyLimits } from "~/v3/services/orgPlanProvisioning.server";
import { enqueueOrgProvisioningJob } from "~/v3/services/orgProvisioningJobs.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const RequestBodySchema = z.object({
  organization: z.number(),
  development: z.number().optional(),
  staging: z.number().optional(),
  production: z.number().optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const body = RequestBodySchema.parse(rawBody);

  if (!body.development && !body.staging && !body.production) {
    return json({ error: "At least one environment limit must be provided" }, { status: 400 });
  }

  await setOrgConcurrencyLimits(organizationId, body, prisma);

  controlPlaneResolver.invalidateOrganization(organizationId);

  await enqueueOrgProvisioningJob("org.pushConcurrencyLimits", organizationId);

  return json({ success: true, queued: true }, { status: 202 });
}

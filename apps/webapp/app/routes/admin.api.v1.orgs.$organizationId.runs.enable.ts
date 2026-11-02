import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireBillingServiceOrAdminApiRequest } from "~/services/billingServiceAuth.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { enqueueOrgProvisioningJob } from "~/v3/services/orgProvisioningJobs.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const BodySchema = z.object({
  enable: z.boolean(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireBillingServiceOrAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);
  const body = BodySchema.safeParse(await request.json());
  if (!body.success) {
    return json({ error: "Invalid request body", details: body.error }, { status: 400 });
  }

  const { count } = await prisma.organization.updateMany({
    where: { id: organizationId },
    data: { runsEnabled: body.data.enable },
  });
  if (count === 0) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  // `runsEnabled` is embedded in every env of the org; drop all its cached env rows.
  controlPlaneResolver.invalidateOrganization(organizationId);

  await enqueueOrgProvisioningJob("org.convergeRunsEnabled", organizationId);

  return json({ success: true, queued: true }, { status: 202 });
}

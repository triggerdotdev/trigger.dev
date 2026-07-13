import { type ActionFunctionArgs, type LoaderFunctionArgs, json, redirect } from "@remix-run/node";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireOrganization } from "~/services/org.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import {
  enqueueProvisionSupportChannel,
  isPaidPlan,
} from "~/services/supportSlackChannel.server";
import { OrganizationParamsSchema, organizationSupportPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const { organization } = await requireOrganization(request, organizationSlug);

  const supportChannel = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId: organization.id },
  });

  const plan = await getCurrentPlan(organization.id);

  return typedjson({
    organization,
    supportChannel,
    isPaying: isPaidPlan(plan),
  });
};

const ActionSchema = z.object({
  intent: z.literal("connect"),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const { organization } = await requireOrganization(request, organizationSlug);

  const formData = await request.formData();
  const result = ActionSchema.safeParse({ intent: formData.get("intent") });
  if (!result.success) {
    return json({ error: "Invalid action" }, { status: 400 });
  }

  const plan = await getCurrentPlan(organization.id);
  if (!isPaidPlan(plan)) {
    return json({ error: "Upgrade required" }, { status: 403 });
  }

  await prisma.organizationSupportChannel.upsert({
    where: { organizationId: organization.id },
    create: { organizationId: organization.id, status: "PROVISIONING" },
    update: { status: "PROVISIONING" },
  });

  await enqueueProvisionSupportChannel({ organizationId: organization.id });

  return redirect(organizationSupportPath(organization));
};

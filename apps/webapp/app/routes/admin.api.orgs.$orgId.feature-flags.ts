import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import {
  flags as getGlobalFlags,
  validatePartialFeatureFlags,
  getAllFlagControlTypes,
} from "~/v3/featureFlags.server";

const ParamsSchema = z.object({
  orgId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { orgId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      title: true,
      slug: true,
      featureFlags: true,
    },
  });

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const orgFlagsResult = organization.featureFlags
    ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
    : ({ success: false } as const);

  const orgFlags = orgFlagsResult.success ? orgFlagsResult.data : {};
  const globalFlags = await getGlobalFlags();
  const controlTypes = getAllFlagControlTypes();

  return json({
    org: {
      id: organization.id,
      title: organization.title,
      slug: organization.slug,
    },
    orgFlags,
    globalFlags,
    controlTypes,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { orgId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  });

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const body = await request.json();

  // body is the full overrides object (or null to clear all)
  if (body === null || (typeof body === "object" && Object.keys(body).length === 0)) {
    await prisma.organization.update({
      where: { id: orgId },
      data: { featureFlags: null },
    });
    return json({ success: true });
  }

  const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
  if (!validationResult.success) {
    return json(
      { error: "Invalid feature flags", details: validationResult.error.issues },
      { status: 400 }
    );
  }

  await prisma.organization.update({
    where: { id: orgId },
    data: { featureFlags: validationResult.data },
  });

  return json({ success: true });
}

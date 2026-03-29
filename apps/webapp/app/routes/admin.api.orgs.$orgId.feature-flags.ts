import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { Prisma } from "@trigger.dev/database";
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

  const [organization, globalFlags] = await Promise.all([
    prisma.organization.findFirst({
      where: { id: orgId },
      select: {
        id: true,
        title: true,
        slug: true,
        featureFlags: true,
      },
    }),
    getGlobalFlags(),
  ]);

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const orgFlagsResult = organization.featureFlags
    ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
    : ({ success: false } as const);

  const orgFlags = orgFlagsResult.success ? orgFlagsResult.data : {};
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
  const body = await request.json();

  let featureFlags: typeof Prisma.JsonNull | Record<string, unknown>;

  if (body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) {
    featureFlags = Prisma.JsonNull;
  } else {
    const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
    if (!validationResult.success) {
      return json(
        { error: "Invalid feature flags", details: validationResult.error.issues },
        { status: 400 }
      );
    }
    featureFlags = validationResult.data;
  }

  try {
    await prisma.organization.update({
      where: { id: orgId },
      data: { featureFlags: featureFlags as Prisma.InputJsonValue },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new Response("Organization not found", { status: 404 });
    }
    throw e;
  }

  return json({ success: true });
}

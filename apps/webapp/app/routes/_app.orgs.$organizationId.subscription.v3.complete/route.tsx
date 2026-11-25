import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { newProjectPath, v3BillingPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationId } = ParamsSchema.parse(params);

  const org = await prisma.organization.findFirst({
    select: {
      slug: true,
      _count: {
        select: {
          projects: true,
        },
      },
    },
    where: {
      id: organizationId,
      deletedAt: null,
      members: { some: { userId } },
    },
  });

  if (!org) {
    throw new Response(null, { status: 404 });
  }

  const hasProject = org._count.projects > 0;

  if (hasProject) {
    return redirectWithSuccessMessage(
      v3BillingPath({ slug: org.slug }),
      request,
      "Your subscription has been successfully activated."
    );
  }

  return redirect(
    newProjectPath({ slug: org.slug }, "Your subscription has been successfully activated.")
  );
};

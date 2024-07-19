import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { newProjectPath, selectPlanPath, v3BillingPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
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
      "Free tier unlocked successfully."
    );
  }

  return redirect(newProjectPath({ slug: org.slug }, "You're on the Free plan."));
};

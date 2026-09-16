import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { v3BillingPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationId } = ParamsSchema.parse(params);

  const org = await prisma.organization.findFirst({
    select: {
      slug: true,
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

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const reason = searchParams.get("reason");

  let errorMessage = reason ? decodeURIComponent(reason) : "Subscribing failed to complete";

  return redirectWithErrorMessage(v3BillingPath({ slug: org.slug }), request, errorMessage);
};

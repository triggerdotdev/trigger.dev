import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { plansPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationId } = ParamsSchema.parse(params);

  const org = await prisma.organization.findUnique({
    select: {
      slug: true,
    },
    where: {
      id: organizationId,
    },
  });

  if (!org) {
    throw new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const reason = searchParams.get("reason");

  let errorMessage = reason ? decodeURIComponent(reason) : "Subscribing failed to complete";

  return redirectWithErrorMessage(`${plansPath({ slug: org.slug })}`, request, errorMessage);
};

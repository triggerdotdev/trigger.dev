import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { subscribedPath } from "~/utils/pathBuilder";

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

  return redirectWithSuccessMessage(
    `${subscribedPath({ slug: org.slug })}`,
    request,
    "You are now subscribed to Trigger.dev"
  );
};

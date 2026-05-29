import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { organizationVercelIntegrationPath } from "~/utils/pathBuilder";

const SearchParamsSchema = z.object({
  configurationId: z.string(),
});

/**
 * Endpoint to handle Vercel integration configuration request coming from marketplace
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireUserId(request);
  const url = new URL(request.url);
  const searchParams = Object.fromEntries(url.searchParams);
  
  const { configurationId } = SearchParamsSchema.parse(searchParams);

  // Find the organization integration by configurationId (installationId in integrationData)
  const integration = await prisma.organizationIntegration.findFirst({
    where: {
      service: "VERCEL",
      deletedAt: null,
      integrationData: {
        path: ["installationId"],
        equals: configurationId,
      },
    },
    include: {
      organization: {
        select: {
          slug: true,
        },
      },
    },
  });

  if (!integration) {
    throw new Response("Integration not found", { status: 404 });
  }

  // Redirect to the organization's Vercel integration page
  return redirect(organizationVercelIntegrationPath(integration.organization));
};

// This route doesn't render anything, it just redirects
export default function VercelConfigurePage() {
  return null;
}
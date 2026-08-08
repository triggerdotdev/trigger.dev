import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { aiHelpRedirectUrl } from "~/components/dashboard-agent/ask-ai-channels";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireUserId } from "~/services/session.server";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const validatedParams = ParamsSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      externalRef: validatedParams.projectRef,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q");

  if (!query) {
    return new Response("No query", { status: 404 });
  }

  return redirect(
    aiHelpRedirectUrl({
      environmentPath: v3EnvironmentPath(
        { slug: project.organization.slug },
        { slug: project.slug },
        { slug: "dev" }
      ),
      origin: env.LOGIN_ORIGIN,
      query,
    })
  );
}

import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { v3EnvironmentPath, v3ProjectPath, v3TestPath } from "~/utils/pathBuilder";

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

  const newUrl = new URL(
    v3EnvironmentPath({ slug: project.organization.slug }, { slug: project.slug }, { slug: "dev" }),
    env.LOGIN_ORIGIN
  );
  newUrl.searchParams.set("aiHelp", query);

  return redirect(newUrl.toString());
}

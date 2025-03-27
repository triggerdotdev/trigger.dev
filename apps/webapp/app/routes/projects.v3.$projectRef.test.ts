import { LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3ProjectPath, v3TestPath } from "~/utils/pathBuilder";

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
  const environment = url.searchParams.get("environment");

  if (environment) {
    return redirect(
      v3TestPath({ slug: project.organization.slug }, { slug: project.slug }, { slug: environment })
    );
  }

  return redirect(v3ProjectPath({ slug: project.organization.slug }, { slug: project.slug }));
}

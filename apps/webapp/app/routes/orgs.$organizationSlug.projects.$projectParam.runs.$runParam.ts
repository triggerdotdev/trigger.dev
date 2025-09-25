import { redirect } from "@remix-run/router";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, v3RunPath } from "~/utils/pathBuilder";

const ParamSchema = ProjectParamSchema.extend({
  runParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, runParam } = ParamSchema.parse(params);

  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId: runParam,
      project: {
        slug: projectParam,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    },
    select: {
      runtimeEnvironment: true,
    },
  });

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(
    v3RunPath(
      {
        slug: organizationSlug,
      },
      { slug: projectParam },
      { slug: run.runtimeEnvironment.slug },
      { friendlyId: runParam }
    )
  );
};

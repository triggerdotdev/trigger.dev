import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { rootPath, v3RunPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { runParam } = ParamsSchema.parse(params);

  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId: runParam,
      project: {
        organization: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    },
    select: {
      runtimeEnvironment: {
        select: {
          slug: true,
        },
      },
      project: {
        select: {
          slug: true,
          organization: {
            select: {
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!run) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "Run either doesn't exist or you don't have permission to view it",
      {
        ephemeral: false,
      }
    );
  }

  return redirect(
    v3RunPath(
      { slug: run.project.organization.slug },
      { slug: run.project.slug },
      { slug: run.runtimeEnvironment.slug },
      { friendlyId: runParam }
    )
  );
}

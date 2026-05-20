import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { impersonate, rootPath, v3RunPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { runParam } = ParamsSchema.parse(params);

  const isAdmin = user.admin || user.isImpersonating;

  if (!isAdmin) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "You're not an admin and cannot impersonate",
      {
        ephemeral: false,
      }
    );
  }

  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId: runParam,
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
    return redirectWithErrorMessage(rootPath(), request, "Run doesn't exist", {
      ephemeral: false,
    });
  }

  const path = v3RunPath(
    { slug: run.project.organization.slug },
    { slug: run.project.slug },
    { slug: run.runtimeEnvironment.slug },
    { friendlyId: runParam }
  );

  return redirect(impersonate(path));
}

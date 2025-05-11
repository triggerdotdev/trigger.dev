import { parse } from "@conform-to/zod";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { type PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createBranchEnvironment } from "~/models/organization.server";
import { requireUser } from "~/services/session.server";
import { v3EnvironmentPath } from "~/utils/pathBuilder";
import { sendToPlain } from "~/utils/plain.server";

export const schema = z.object({
  parentEnvironmentId: z.string(),
  branchName: z.string().min(1),
  failurePath: z.string(),
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  try {
    const parentEnvironment = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: {
        id: submission.value.parentEnvironmentId,
        organization: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
      include: {
        organization: true,
        project: true,
      },
    });

    if (!parentEnvironment.isBranchableEnvironment) {
      return redirectWithErrorMessage(
        submission.value.failurePath,
        request,
        "Parent environment is not branchable"
      );
    }

    const branch = await createBranchEnvironment({
      organization: parentEnvironment.organization,
      project: parentEnvironment.project,
      parentEnvironment,
      branchName: submission.value.branchName,
    });

    return redirectWithSuccessMessage(
      v3EnvironmentPath(parentEnvironment.organization, parentEnvironment.project, branch),
      request,
      "Thanks for your feedback! We'll get back to you soon."
    );
  } catch (e) {
    submission.error.message = e instanceof Error ? e.message : "Unknown error";
    return redirectWithErrorMessage(
      submission.value.failurePath,
      request,
      "Failed to create branch"
    );
  }
}

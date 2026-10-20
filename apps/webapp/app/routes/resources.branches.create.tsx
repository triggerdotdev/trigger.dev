import { parseWithZod } from "@conform-to/zod/v4";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { rbac } from "~/services/rbac.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { toBranchableEnvironmentType } from "~/utils/branchableEnvironment";
import { CreateBranchFormSchema } from "~/utils/branches";
import { branchesDevPath, branchesPath } from "~/utils/pathBuilder";

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: CreateBranchFormSchema });

  if (submission.status !== "success") {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const project = await $replica.project.findFirst({
    where: {
      id: submission.value.projectId,
      organization: { members: { some: { userId } } },
    },
    select: { id: true, organizationId: true },
  });
  if (!project) {
    return json(submission.reply({ formErrors: ["Project not found"] }), { status: 404 });
  }

  const environmentType = toBranchableEnvironmentType(submission.value.env);
  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const canCreate =
    auth.ok &&
    (auth.ability.can("write", { type: "branches", envType: environmentType }) ||
      auth.ability.can("write", { type: "deployments", envType: environmentType }));
  if (!canCreate) {
    return json(
      submission.reply({ formErrors: ["You don't have permission to create branches."] }),
      { status: 403 }
    );
  }

  const upsertBranchService = new UpsertBranchService();
  const result = await upsertBranchService.call(
    { type: "userMembership", userId },
    submission.value
  );

  if (result.success) {
    if (result.alreadyExisted) {
      return json(
        submission.reply({
          fieldErrors: {
            branchName: [
              `Branch "${result.branch.branchName}" already exists. You can archive it and create a new one with the same name.`,
            ],
          },
        })
      );
    }

    // Branches of both types are created through here; route the success
    // redirect to the matching list page based on the created branch's type.
    const path =
      result.branch.type === "DEVELOPMENT"
        ? branchesDevPath(result.organization, result.project, result.branch)
        : branchesPath(result.organization, result.project, result.branch);

    return redirectWithSuccessMessage(
      `${path}?dialogClosed=true`,
      request,
      `Branch "${result.branch.branchName}" created`
    );
  }

  return json(submission.reply({ fieldErrors: { branchName: [result.error] } }));
}

import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useLocation } from "@remix-run/react";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { ArchiveIcon } from "~/assets/icons/ArchiveIcon";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Paragraph } from "~/components/primitives/Paragraph";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { rbac } from "~/services/rbac.server";
import { requireUserId } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";

const ArchiveBranchOptions = z.object({
  environmentId: z.string(),
});

const schema = ArchiveBranchOptions.and(
  z.object({
    redirectPath: z.string(),
  })
);

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== "success") {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const redirectPath = sanitizeRedirectPath(submission.value.redirectPath);

  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id: submission.value.environmentId,
      organization: { members: { some: { userId } } },
    },
    select: { type: true, organizationId: true, projectId: true },
  });
  if (!environment) {
    return redirectWithErrorMessage(redirectPath, request, "Branch not found");
  }

  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
  });
  if (!auth.ok || !auth.ability.can("write", { type: "deployments", envType: environment.type })) {
    return redirectWithErrorMessage(
      redirectPath,
      request,
      "You don't have permission to archive this branch."
    );
  }

  const archiveBranchService = new ArchiveBranchService();

  const result = await archiveBranchService.call(
    { type: "userMembership", userId },
    {
      environmentId: submission.value.environmentId,
    }
  );

  if (result.success) {
    return redirectWithSuccessMessage(
      redirectPath,
      request,
      `Branch "${result.branch.branchName}" archived`
    );
  }

  return redirectWithErrorMessage(redirectPath, request, result.error);
}

export function ArchiveButton({
  environment,
  canArchive,
  disabled,
}: {
  environment: { id: string; branchName: string };
  canArchive: boolean;
  disabled?: boolean;
}) {
  const lastSubmission = useActionData<typeof action>();
  const location = useLocation();

  const [form, { environmentId, redirectPath }] = useForm({
    id: "archive-branch",
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={ArchiveIcon}
          leadingIconClassName="text-error"
          fullWidth
          textAlignLeft
          className="w-full px-1.5 py-[0.9rem]"
          disabled={disabled || !canArchive}
          tooltip={canArchive ? undefined : "You don't have permission to archive this branch."}
        >
          Archive branch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Archive "{environment.branchName}"</DialogHeader>
        <div className="mt-2 flex flex-col gap-4">
          <Form
            method="post"
            action="/resources/branches/archive"
            {...getFormProps(form)}
            className="w-full"
          >
            <input
              value={environment.id}
              {...getInputProps(environmentId, { type: "hidden", value: false })}
            />
            <input
              value={`${location.pathname}${location.search}`}
              {...getInputProps(redirectPath, { type: "hidden", value: false })}
            />
            <Paragraph spacing>
              This will <span className="text-text-bright">permanently</span> make this branch{" "}
              <span className="text-text-bright">read-only</span>. You won't be able to trigger
              runs, execute runs, or use the API for this branch.
            </Paragraph>
            <Paragraph spacing>
              You will still be able to view the branch and its associated runs.
            </Paragraph>
            <Paragraph spacing>
              Once archived you can create a new branch with the same name.
            </Paragraph>
            <FormError>{form.errors?.join(", ")}</FormError>
            <FormButtons
              confirmButton={
                <Button LeadingIcon={ArchiveIcon} type="submit" variant="danger/medium">
                  Archive branch
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant="secondary/medium">Cancel</Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

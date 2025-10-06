import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useFetcher, useLocation } from "@remix-run/react";
import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { ArchiveIcon } from "~/assets/icons/ArchiveIcon";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Paragraph } from "~/components/primitives/Paragraph";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { requireUserId } from "~/services/session.server";
import { branchesPath, v3EnvironmentPath } from "~/utils/pathBuilder";

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
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
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
      branchesPath(result.organization, result.project, result.branch),
      request,
      `Branch "${result.branch.branchName}" archived`
    );
  }

  return redirectWithErrorMessage(submission.value.redirectPath, request, result.error);
}

export function ArchiveButton({
  environment,
}: {
  environment: { id: string; branchName: string };
}) {
  const lastSubmission = useActionData<typeof action>();
  const location = useLocation();

  const [form, { environmentId, redirectPath }] = useForm({
    id: "archive-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
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
            {...form.props}
            className="w-full"
          >
            <input value={environment.id} {...conform.input(environmentId, { type: "hidden" })} />
            <input
              value={`${location.pathname}${location.search}`}
              {...conform.input(redirectPath, { type: "hidden" })}
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
            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <Button LeadingIcon={ArchiveIcon} type="submit" variant="danger/medium">
                  Archive branch
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useFetcher } from "@remix-run/react";
import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { Button } from "~/components/primitives/Buttons";
import { DialogHeader } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { branchesPath, v3EnvironmentPath } from "~/utils/pathBuilder";

export const CreateBranchOptions = z.object({
  parentEnvironmentId: z.string(),
  branchName: z.string().min(1),
  git: z
    .object({
      repoOwner: z.string(),
      repoName: z.string(),
      refFull: z.string(),
      refType: z.enum(["branch", "tag", "commit", "pull_request"]),
      commitSha: z.string(),
      createdBy: z.string().optional(),
      pullRequestNumber: z.number().optional(),
    })
    .optional(),
});

export type CreateBranchOptions = z.infer<typeof CreateBranchOptions>;

export const schema = CreateBranchOptions.and(
  z.object({
    failurePath: z.string(),
  })
);

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const upsertBranchService = new UpsertBranchService();
  const result = await upsertBranchService.call(userId, submission.value);

  if (result.success) {
    if (result.alreadyExisted) {
      submission.error = { branchName: `Branch "${result.branch.branchName}" already exists` };
      return json(submission);
    }

    return redirectWithSuccessMessage(
      branchesPath(result.organization, result.project, result.branch),
      request,
      `Branch "${result.branch.branchName}" created`
    );
  }

  submission.error = { branchName: result.error };
  return json(submission);
}

export function NewBranchPanel({ parentEnvironment }: { parentEnvironment: { id: string } }) {
  const fetcher = useFetcher<typeof action>();

  const [form, { parentEnvironmentId, branchName, failurePath }] = useForm({
    id: "create-branch",
    lastSubmission: fetcher.data as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  return (
    <>
      <DialogHeader>New branch</DialogHeader>
      <div className="mt-2 flex flex-col gap-4">
        <fetcher.Form
          method="post"
          action="/resources/branches/new"
          {...form.props}
          className="w-full"
        >
          <Fieldset className="max-w-full gap-y-3">
            <input
              value={parentEnvironment.id}
              {...conform.input(parentEnvironmentId, { type: "hidden" })}
            />
            <input value={location.pathname} {...conform.input(failurePath, { type: "hidden" })} />
            <InputGroup className="max-w-full">
              <Label>Branch name</Label>
              <Input {...conform.input(branchName)} />
              <Hint>
                Must not contain: spaces <InlineCode variant="extra-small">~</InlineCode>{" "}
                <InlineCode variant="extra-small">^</InlineCode>{" "}
                <InlineCode variant="extra-small">:</InlineCode>{" "}
                <InlineCode variant="extra-small">?</InlineCode>{" "}
                <InlineCode variant="extra-small">*</InlineCode>{" "}
                <InlineCode variant="extra-small">{"["}</InlineCode>{" "}
                <InlineCode variant="extra-small">\\</InlineCode>{" "}
                <InlineCode variant="extra-small">//</InlineCode>{" "}
                <InlineCode variant="extra-small">..</InlineCode>{" "}
                <InlineCode variant="extra-small">{"@{"}</InlineCode>{" "}
                <InlineCode variant="extra-small">.lock</InlineCode>
              </Hint>
              <FormError id={branchName.errorId}>{branchName.error}</FormError>
            </InputGroup>
            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium">
                  Create branch
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
              }
            />
          </Fieldset>
        </fetcher.Form>
      </div>
    </>
  );
}

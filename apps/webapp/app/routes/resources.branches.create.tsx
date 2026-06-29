import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useLocation, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { type BranchableEnvironmentToken } from "~/utils/branchableEnvironment";
import { CreateBranchFormSchema } from "~/utils/branches";
import { branchesDevPath, branchesPath } from "~/utils/pathBuilder";

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema: CreateBranchFormSchema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const upsertBranchService = new UpsertBranchService();
  const result = await upsertBranchService.call(
    { type: "userMembership", userId },
    submission.value
  );

  if (result.success) {
    if (result.alreadyExisted) {
      submission.error = {
        branchName: [
          `Branch "${result.branch.branchName}" already exists. You can archive it and create a new one with the same name.`,
        ],
      };
      return json(submission);
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

  submission.error = { branchName: [result.error] };
  return json(submission);
}

export function NewBranchPanel({
  button,
  env,
}: {
  button: React.ReactNode;
  env: BranchableEnvironmentToken;
}) {
  const project = useProject();
  // Posts to this resource route (not the host page), so read the submission
  // result off the fetcher rather than the page's `useActionData`.
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);

  const [form, { projectId, env: envField, branchName, failurePath }] = useForm({
    id: "create-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: CreateBranchFormSchema });
    },
    shouldRevalidate: "onInput",
  });

  useEffect(() => {
    if (searchParams.has("dialogClosed")) {
      setSearchParams((s) => {
        s.delete("dialogClosed");
        return s;
      });
      setIsOpen(false);
    }
  }, [searchParams, setSearchParams]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{button}</DialogTrigger>
      <DialogContent>
        <DialogHeader>New branch</DialogHeader>
        <div className="mt-2 flex flex-col gap-4">
          <fetcher.Form
            method="post"
            action="/resources/branches/create"
            {...form.props}
            className="w-full"
          >
            <Fieldset className="max-w-full gap-y-3">
              <input value={project.id} {...conform.input(projectId, { type: "hidden" })} />
              <input value={env} {...conform.input(envField, { type: "hidden" })} />
              <input
                value={location.pathname}
                {...conform.input(failurePath, { type: "hidden" })}
              />
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
                  <InlineCode variant="extra-small">\</InlineCode>{" "}
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
      </DialogContent>
    </Dialog>
  );
}

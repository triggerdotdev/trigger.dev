import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useLocation, useSearchParams } from "@remix-run/react";
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
import type { action } from "~/routes/resources.branches.create";
import type { BranchableEnvironmentToken } from "~/utils/branchableEnvironment";
import { CreateBranchFormSchema } from "~/utils/branches";

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
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: CreateBranchFormSchema });
    },
    shouldRevalidate: "onInput",
  });

  useEffect(() => {
    if (searchParams.has("dialogClosed")) {
      setSearchParams((s) => {
        s.delete("dialogClosed");
        return s;
      });
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
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
            {...getFormProps(form)}
            className="w-full"
          >
            <Fieldset className="max-w-full gap-y-3">
              <input value={project.id} {...getInputProps(projectId, { type: "hidden" })} />
              <input value={env} {...getInputProps(envField, { type: "hidden" })} />
              <input
                value={location.pathname}
                {...getInputProps(failurePath, { type: "hidden" })}
              />
              <InputGroup className="max-w-full">
                <Label>Branch name</Label>
                <Input {...getInputProps(branchName, { type: "text" })} />
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
                <FormError id={branchName.errorId}>{branchName.errors}</FormError>
              </InputGroup>
              <FormError>{form.errors}</FormError>
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

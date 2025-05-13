import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData } from "@remix-run/react";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { type SideMenuEnvironment } from "~/components/navigation/SideMenu";
import { Button } from "~/components/primitives/Buttons";
import { DialogHeader } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createBranchEnvironment } from "~/models/organization.server";
import { requireUser } from "~/services/session.server";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

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

export function NewBranchPanel({ parentEnvironment }: { parentEnvironment: { id: string } }) {
  const lastSubmission = useActionData();

  const [form, { parentEnvironmentId, branchName, failurePath }] = useForm({
    id: "accept-invite",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  return (
    <>
      <DialogHeader>New branch</DialogHeader>
      <div className="mt-2 flex flex-col gap-4">
        <Form method="post" action="/resources/branches/new" {...form.props} className="w-full">
          <Fieldset className="max-w-full gap-y-3">
            <input
              value={parentEnvironment.id}
              {...conform.input(parentEnvironmentId, { type: "hidden" })}
            />
            <input value={location.pathname} {...conform.input(failurePath, { type: "hidden" })} />
            <InputGroup className="max-w-full">
              <Label>Branch name</Label>
              <Input {...conform.input(branchName)} />
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
        </Form>
      </div>
    </>
  );
}

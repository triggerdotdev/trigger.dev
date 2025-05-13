import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { PlusIcon } from "@heroicons/react/24/outline";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useLocation } from "@remix-run/react";
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { ArchiveIcon, UnarchiveIcon } from "~/assets/icons/ArchiveIcon";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { requireUserId } from "~/services/session.server";
import { v3BillingPath, v3EnvironmentPath } from "~/utils/pathBuilder";

const ArchiveBranchOptions = z.object({
  environmentId: z.string(),
  action: z.enum(["archive", "unarchive"]),
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

  const result = await archiveBranchService.call(userId, submission.value);

  if (result.success) {
    return redirectWithSuccessMessage(
      submission.value.redirectPath,
      request,
      `Branch "${result.branch.branchName}" ${
        submission.value.action === "archive" ? "archived" : "unarchived"
      }`
    );
  }

  return redirectWithErrorMessage(submission.value.redirectPath, request, result.error);
}

export function ArchiveButton({
  environment,
}: {
  environment: { id: string; branchName: string };
}) {
  const location = useLocation();
  const lastSubmission = useActionData();

  const [form, { environmentId, action, redirectPath }] = useForm({
    id: "archive-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  return (
    <>
      <Form method="post" action="/resources/branches/archive" {...form.props} className="w-full">
        <input value={environment.id} {...conform.input(environmentId, { type: "hidden" })} />
        <input value={"archive"} {...conform.input(action, { type: "hidden" })} />
        <input
          value={`${location.pathname}${location.search}`}
          {...conform.input(redirectPath, { type: "hidden" })}
        />
        <FormError>{form.error}</FormError>
        <Button
          type="submit"
          variant="small-menu-item"
          LeadingIcon={ArchiveIcon}
          leadingIconClassName="text-error"
          fullWidth
          textAlignLeft
          className="w-full px-1.5 py-[0.9rem]"
        >
          Archive branch
        </Button>
      </Form>
    </>
  );
}

export function UnarchiveButton({
  environment,
  limits,
  canUpgrade,
}: {
  environment: { id: string; branchName: string };
  limits: { used: number; limit: number; isAtLimit: boolean };
  canUpgrade: boolean;
}) {
  const location = useLocation();
  const organization = useOrganization();
  const lastSubmission = useActionData();

  const [form, { environmentId, action, redirectPath }] = useForm({
    id: "archive-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  if (limits.isAtLimit) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button
            variant="small-menu-item"
            LeadingIcon={UnarchiveIcon}
            leadingIconClassName="text-text-dimmed"
            fullWidth
            textAlignLeft
            className="w-full px-1.5 py-[0.9rem]"
          >
            Unarchive
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>You've exceeded your branch limit</DialogHeader>
          <div className="mt-2">
            <Paragraph spacing>
              You've used {limits.used}/{limits.limit} of your branches.
            </Paragraph>
            <Paragraph>You can archive one or upgrade your plan for more.</Paragraph>
          </div>
          <DialogFooter>
            {canUpgrade ? (
              <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
                Upgrade
              </LinkButton>
            ) : (
              <Feedback
                button={<Button variant="primary/small">Request more</Button>}
                defaultValue="help"
              />
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Form method="post" action="/resources/branches/archive" {...form.props} className="w-full">
      <input value={environment.id} {...conform.input(environmentId, { type: "hidden" })} />
      <input value={"unarchive"} {...conform.input(action, { type: "hidden" })} />
      <input
        value={`${location.pathname}${location.search}`}
        {...conform.input(redirectPath, { type: "hidden" })}
      />
      <Button
        type="submit"
        variant="small-menu-item"
        LeadingIcon={UnarchiveIcon}
        leadingIconClassName="text-text-dimmed"
        fullWidth
        textAlignLeft
        className="w-full px-1.5 py-[0.9rem]"
      >
        Unarchive
      </Button>
    </Form>
  );
}

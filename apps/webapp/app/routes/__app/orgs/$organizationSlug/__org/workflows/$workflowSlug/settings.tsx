import { Form } from "@remix-run/react";
import type { ActionArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { z } from "zod";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import { EnvironmentBanner } from "~/components/EnvironmentBanner";
import { Panel } from "~/components/layout/Panel";
import {
  DangerButton,
  PrimaryButton,
  SecondaryButton,
} from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import type { CurrentWorkflow } from "~/hooks/useWorkflows";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { ArchiveWorkflow } from "~/services/workflows/archiveWorkflow.server";
import { DisableEventRule } from "~/services/workflows/disableEventRule.server";
import { EnableEventRule } from "~/services/workflows/enableEventRule.server";
import { UnarchiveWorkflow } from "~/services/workflows/unarchiveWorkflow.server";

const ActionSchema = z.enum(["disable", "enable", "archive", "unarchive"]);
const FormSchema = z.object({
  action: ActionSchema,
});
const ParamsSchema = z.object({
  organizationSlug: z.string(),
  workflowSlug: z.string(),
});

export async function action({ params, request }: ActionArgs) {
  const userId = await requireUserId(request);

  const formData = Object.fromEntries(await request.formData());
  const { action } = FormSchema.parse(formData);
  const { organizationSlug, workflowSlug } = ParamsSchema.parse(params);

  switch (action) {
    case "archive":
      return archiveAction(userId, organizationSlug, workflowSlug, request);
    case "unarchive":
      return unarchiveAction(userId, organizationSlug, workflowSlug, request);
  }
}

async function archiveAction(
  userId: string,
  organizationSlug: string,
  workflowSlug: string,
  request: Request
) {
  const service = new ArchiveWorkflow();
  const result = await service.call(userId, organizationSlug, workflowSlug);

  if (result.status === "error") {
    return redirectBackWithErrorMessage(request, result.message);
  }

  return redirectWithSuccessMessage(
    `/orgs/${organizationSlug}`,
    request,
    "Workflow successfully archived."
  );
}

async function unarchiveAction(
  userId: string,
  organizationSlug: string,
  workflowSlug: string,
  request: Request
) {
  const service = new UnarchiveWorkflow();
  const result = await service.call(userId, organizationSlug, workflowSlug);

  if (result.status === "error") {
    return redirectBackWithErrorMessage(request, result.message);
  }

  return redirectBackWithSuccessMessage(
    request,
    "Workflow successfully unarchived. Enable it to resume new events."
  );
}

export default function Page() {
  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");

  const panel = !workflow.isArchived ? (
    <WorkflowReadyPanel workflow={workflow} />
  ) : workflow.isArchived ? (
    <WorkflowArchivedPanel workflow={workflow} />
  ) : null;

  return (
    <>
      <EnvironmentBanner />
      <Title>Settings</Title>
      <SubTitle>Workflow status</SubTitle>
      {panel}
    </>
  );
}

function WorkflowReadyPanel({
  workflow,
}: {
  workflow: NonNullable<CurrentWorkflow>;
}) {
  return (
    <Panel className="flex items-center justify-between !p-4">
      <div className="flex items-center gap-4">
        <ApiLogoIcon size="regular" />
        <Header3 size="small" className="text-slate-300">
          {workflow.title} <span className="text-green-500">is active.</span>
        </Header3>
      </div>
      <div className="flex gap-3">
        <Form
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Archiving this workflow disables it in both dev and live environments, and removes it from your list of workflows. Are you sure you want to archive this workflow?"
            ) && e.preventDefault()
          }
        >
          <DangerButton name="action" value="archive" type="submit">
            Archive
          </DangerButton>
        </Form>
      </div>
    </Panel>
  );
}

function WorkflowArchivedPanel({
  workflow,
}: {
  workflow: NonNullable<CurrentWorkflow>;
}) {
  return (
    <Panel className="flex items-center justify-between !p-4">
      <div className="flex items-center gap-4">
        <ApiLogoIcon size="regular" />
        <Header3 size="small" className="text-slate-300">
          {workflow.title} <span className="text-rose-500">is archived.</span>
        </Header3>
      </div>
      <div className="flex gap-3">
        <Form
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Unarchiving this workflow will add it back to your list of workflows, but not enable it. Are you sure you want to unarchive this workflow?"
            ) && e.preventDefault()
          }
        >
          <PrimaryButton name="action" value="unarchive" type="submit">
            Unarchive
          </PrimaryButton>
        </Form>
      </div>
    </Panel>
  );
}

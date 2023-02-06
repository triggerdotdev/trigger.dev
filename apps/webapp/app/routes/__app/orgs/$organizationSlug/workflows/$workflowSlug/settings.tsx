import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
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
import invariant from "tiny-invariant";
import { Form } from "@remix-run/react";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import {
  redirectBackWithErrorMessage,
  redirectBackWithSuccessMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { DisableWorkflow } from "~/services/workflows/disableWorkflow.server";
import { EnableWorkflow } from "~/services/workflows/enableWorkflow.server";
import { ArchiveWorkflow } from "~/services/workflows/archiveWorkflow.server";
import { UnarchiveWorkflow } from "~/services/workflows/unarchiveWorkflow.server";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { WorkflowTestPresenter } from "~/presenters/testPresenter.server";

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
    case "disable":
      return disableAction(userId, organizationSlug, workflowSlug, request);
    case "enable":
      return enableAction(userId, organizationSlug, workflowSlug, request);
    case "archive":
      return archiveAction(userId, organizationSlug, workflowSlug, request);
    case "unarchive":
      return unarchiveAction(userId, organizationSlug, workflowSlug, request);
  }
}

async function disableAction(
  userId: string,
  organizationSlug: string,
  workflowSlug: string,
  request: Request
) {
  const service = new DisableWorkflow();
  const result = await service.call(userId, organizationSlug, workflowSlug);

  if (result.status === "error") {
    return redirectBackWithErrorMessage(request, result.message);
  }

  return redirectBackWithSuccessMessage(
    request,
    "Workflow successfully disabled. No new events will run."
  );
}

async function enableAction(
  userId: string,
  organizationSlug: string,
  workflowSlug: string,
  request: Request
) {
  const service = new EnableWorkflow();
  const result = await service.call(userId, organizationSlug, workflowSlug);

  if (result.status === "error") {
    return redirectBackWithErrorMessage(request, result.message);
  }

  return redirectBackWithSuccessMessage(
    request,
    "Workflow successfully enabled. New events will resume."
  );
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

  const panel =
    workflow.status === "READY" || workflow.status === "CREATED" ? (
      <WorkflowReadyPanel workflow={workflow} />
    ) : workflow.isArchived ? (
      <WorkflowArchivedPanel workflow={workflow} />
    ) : workflow.status === "DISABLED" ? (
      <WorkflowDisabledPanel workflow={workflow} />
    ) : null;

  return (
    <>
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
              "Disabling this workflow will prevent any new triggers from running, but will not stop in-progress runs from completing. Are you sure you want to disable this workflow?"
            ) && e.preventDefault()
          }
        >
          <SecondaryButton name="action" value="disable" type="submit">
            Disable
          </SecondaryButton>
        </Form>

        <Form
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Archiving this workflow disables it and removes it from your list of workflows. Are you sure you want to archive this workflow?"
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

function WorkflowDisabledPanel({
  workflow,
}: {
  workflow: NonNullable<CurrentWorkflow>;
}) {
  return (
    <Panel className="flex items-center justify-between !p-4">
      <div className="flex items-center gap-4">
        <ApiLogoIcon size="regular" />
        <Header3 size="small" className="text-slate-300">
          {workflow.title} <span className="text-amber-300">is disabled.</span>
        </Header3>
      </div>
      <div className="flex gap-3">
        <Form
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Enabling this workflow will resume triggering workflows from new events. Are you sure you want to enable this workflow?"
            ) && e.preventDefault()
          }
        >
          <PrimaryButton name="action" value="enable" type="submit">
            Enable
          </PrimaryButton>
        </Form>

        <Form
          method="post"
          onSubmit={(e) =>
            !confirm(
              "Archiving this workflow will remove it from your list of workflows. Are you sure you want to archive this workflow?"
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

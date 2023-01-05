import type { ActionArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { z } from "zod";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { getOrganizationFromSlug } from "~/models/organization.server";
import {
  getRuntimeEnvironment,
  getRuntimeEnvironmentFromRequest,
} from "~/models/runtimeEnvironment.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { CreateWorkflowTestRun } from "~/services/runs/createTestRun.server";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  eventName: z.string(),
  payload: z.string(),
  source: z.enum(["rerun", "test"]),
});

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const { workflowSlug, organizationSlug } = params;
  invariant(workflowSlug, "workflowSlug is required");
  invariant(organizationSlug, "organizationSlug is required");

  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const body = Object.fromEntries(formData.entries());
    const { eventName, payload, source } = requestSchema.parse(body);

    const jsonPayload = JSON.parse(payload);

    const workflow = await getWorkflowFromSlugs({
      userId,
      organizationSlug,
      workflowSlug,
    });
    invariant(workflow, "workflow is required");

    const organization = await getOrganizationFromSlug({
      userId,
      slug: organizationSlug,
    });
    invariant(organization, "organization is required");

    const environmentSlug = await getRuntimeEnvironmentFromRequest(request);
    const environment = await getRuntimeEnvironment({
      organizationId: organization.id,
      slug: environmentSlug,
    });
    invariant(environment, "environment is required");

    //todo choose event name from form dropdown
    const createTestRunService = new CreateWorkflowTestRun();
    const run = await createTestRunService.call({
      payload: jsonPayload,
      eventName,
      workflow,
      environment,
      organization,
    });

    if (!run) {
      return redirectWithErrorMessage(
        `/orgs/${organizationSlug}/workflows/${workflowSlug}/runs`,
        request,
        errorMessageForSource(source)
      );
    }

    return redirectWithSuccessMessage(
      `/orgs/${organizationSlug}/workflows/${workflowSlug}/runs/${run.id}`,
      request,
      successMessageForSource(source)
    );
  } catch (error: any) {
    console.error(error);
    throw new Response(error.message, { status: 400 });
  }
};

function errorMessageForSource(source: "rerun" | "test") {
  if (source === "rerun") {
    return "Unable to rerun this workflow. Please contact help@trigger.dev for assistance.";
  } else {
    return "Unable to create a test run for this workflow. Please contact help@trigger.dev for assistance.";
  }
}

function successMessageForSource(source: "rerun" | "test") {
  if (source === "rerun") {
    return "Workflow successfully rerun";
  } else {
    return "Test event successfully sent";
  }
}

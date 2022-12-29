import type { ActionArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { ulid } from "ulid";
import { z } from "zod";
import { getOrganizationFromSlug } from "~/models/organization.server";
import {
  getRuntimeEnvironment,
  getRuntimeEnvironmentFromRequest,
} from "~/models/runtimeEnvironment.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { IngestEvent } from "~/services/events/ingest.server";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  payload: z.string(),
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
    const { payload } = requestSchema.parse(body);

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
    const ingestService = new IngestEvent();
    await ingestService.call(
      {
        id: ulid(),
        name: workflow.eventNames[0],
        type: workflow.type,
        service: workflow.service,
        payload: jsonPayload,
        context: {},
        apiKey: environment.apiKey,
        isTest: true,
      },
      organization
    );

    //todo redirect to the runs page
    return null;
  } catch (error: any) {
    console.error(error);
    throw new Response(error.message, { status: 400 });
  }
};

import type { ActionArgs } from "@remix-run/server-runtime";
import { TriggerMetadataSchema } from "@trigger.dev/common-schemas";
import invariant from "tiny-invariant";
import { ulid } from "ulid";
import { z } from "zod";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { IngestEvent } from "~/services/events/ingest.server";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  environmentId: z.string(),
  apiKey: z.string(),
  payload: z.any(),
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
    const { payload, apiKey, environmentId } = requestSchema.parse(body);

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

    const activeEventRule = workflow.rules.find(
      (r) => r.environmentId === environmentId
    );

    const eventRule = TriggerMetadataSchema.parse(activeEventRule);

    const ingestService = new IngestEvent();
    await ingestService.call(
      {
        id: ulid(),
        name: eventRule.name,
        type: workflow.type,
        service: eventRule.service,
        payload: payload,
        context: {},
        apiKey: apiKey,
      },
      organization
    );
  } catch (error: any) {
    console.error(error);
    throw new Response(error.message, { status: 400 });
  }
};

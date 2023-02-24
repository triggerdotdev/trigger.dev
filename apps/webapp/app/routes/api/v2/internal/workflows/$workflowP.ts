import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { RegisterWorkflow } from "~/services/workflows/registerWorkflow.server";

// PUT /api/v2/internal/workflows/:workflowP
export async function action({ request, params }: ActionArgs) {
  // first make sure this is a PUT request
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  // Now parse the request body
  const body = await request.json();

  // And the params
  const { workflowP } = z.object({ workflowP: z.string() }).parse(params);

  const registerWorkflow = new RegisterWorkflow();

  const result = await registerWorkflow.call(
    workflowP,
    body,
    authenticatedEnv.organization,
    authenticatedEnv
  );

  switch (result.status) {
    case "validationError": {
      return json({ error: result.errors }, { status: 400 });
    }
    case "isArchived": {
      return json({ error: "Workflow is archived" }, { status: 400 });
    }
    case "success": {
      const { workflow, environment, organization, isNew } = result.data;

      const data = {
        workflow: {
          id: workflow.id,
          slug: workflow.slug,
        },
        environment: {
          id: environment.id,
          slug: environment.slug,
        },
        organization: {
          id: organization.id,
          slug: organization.slug,
        },
        url: `${env.APP_ORIGIN}/orgs/${organization.slug}/workflows/${workflow.slug}`,
      };

      return json(data, { status: isNew ? 201 : 200 });
    }
  }
}

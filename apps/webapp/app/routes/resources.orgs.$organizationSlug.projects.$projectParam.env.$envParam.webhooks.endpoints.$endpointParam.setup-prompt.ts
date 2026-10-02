import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { webhookReplica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { buildWebhookSetupPrompt, webhookSetupPromptSelect } from "~/v3/webhookSetupPrompt.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";

const ParamsSchema = EnvironmentParamSchema.extend({ endpointParam: z.string() });

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam, endpointParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  await requireWebhooksAccess(user, project.organizationId);

  const endpoint = await webhookReplica.webhookEndpoint.findFirst({
    where: { friendlyId: endpointParam, runtimeEnvironmentId: environment.id },
    select: webhookSetupPromptSelect,
  });
  if (!endpoint) throw new Response("Endpoint not found", { status: 404 });

  return json({ prompt: buildWebhookSetupPrompt(endpoint, environment) });
}

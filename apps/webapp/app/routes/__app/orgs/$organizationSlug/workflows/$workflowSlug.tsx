import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import {
  ManualWebhookSourceSchema,
  TriggerMetadataSchema,
} from "@trigger.dev/common-schemas";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import {
  SideMenuContainer,
  WorkflowsSideMenu,
} from "~/components/navigation/SideMenu";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import { buildExternalSourceUrl } from "~/models/externalSource.server";
import { getIntegrations } from "~/models/integrations.server";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { requireUser } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(workflowSlug, "workflowSlug not found");

  let workflow = await getWorkflowFromSlugs({
    userId: user.id,
    organizationSlug,
    workflowSlug,
  });

  if (workflow === null) {
    throw new Response("Not Found", { status: 404 });
  }

  const integrations = getIntegrations(user.admin);

  const rules = workflow.rules.map((r) => ({
    ...r,
    trigger: TriggerMetadataSchema.parse(r.trigger),
  }));

  const currentEnvironmentSlug = await getRuntimeEnvironmentFromRequest(
    request
  );

  const allConnections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  const externalSourceIntegration = integrations.find(
    (i) => i.slug === workflow?.externalSource?.service
  );
  const externalSourceSlot =
    workflow.externalSource && externalSourceIntegration
      ? {
          ...workflow.externalSource,
          possibleConnections: allConnections.filter(
            (a) => a.apiIdentifier === workflow?.externalSource?.service
          ),
          integration: externalSourceIntegration,
        }
      : undefined;

  const connectionSlots = {
    source: externalSourceSlot,
    services: workflow.externalServices.flatMap((c) => {
      const integration = integrations.find((i) => i.slug === c.service);

      if (!integration) {
        return [];
      }

      return {
        ...c,
        possibleConnections: allConnections.filter(
          (a) => a.apiIdentifier === c.service
        ),
        integration,
      };
    }),
  };

  const externalSourceSecret =
    workflow.externalSource &&
    workflow.externalSource.manualRegistration &&
    ManualWebhookSourceSchema.safeParse(workflow.externalSource.source)
      .success &&
    ManualWebhookSourceSchema.parse(workflow.externalSource.source)
      .verifyPayload.enabled
      ? workflow.externalSource.secret
      : undefined;

  return typedjson({
    workflow: {
      ...workflow,
      rules,
      externalSourceUrl: workflow.externalSource
        ? buildExternalSourceUrl(
            workflow.externalSource.id,
            workflow.externalSource.service
          )
        : undefined,
      externalSourceSecret: externalSourceSecret,
    },
    currentEnvironmentSlug,
    connectionSlots,
  });
};

export default function Page() {
  return (
    <>
      <SideMenuContainer>
        <WorkflowsSideMenu />
        <Container>
          <Outlet />
        </Container>
      </SideMenuContainer>
    </>
  );
}

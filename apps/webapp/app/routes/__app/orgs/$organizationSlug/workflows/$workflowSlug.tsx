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

type ExternalSourceConfig =
  | ExternalSourceIntegrationConfig
  | ExternalSourceManualConfig;

type ExternalSourceIntegrationConfig = {
  type: "integration";
  url: string;
};

type ExternalSourceManualConfig = {
  type: "manual";
  data: ManualConfigDataSuccess | ManualConfigDataError;
};

type ManualConfigDataError = {
  success: false;
  error: string;
};

type ManualConfigDataSuccess = {
  success: true;
  url: string;
  secret?: string;
};

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
    (i) => i.metadata.slug === workflow?.externalSource?.service
  );
  const externalSourceSlot =
    workflow.externalSource && externalSourceIntegration
      ? {
          ...workflow.externalSource,
          possibleConnections: allConnections.filter(
            (a) => a.apiIdentifier === workflow?.externalSource?.service
          ),
          integration: externalSourceIntegration.metadata,
        }
      : undefined;

  const connectionSlots = {
    source: externalSourceSlot,
    services: workflow.externalServices.flatMap((c) => {
      const integration = integrations.find(
        (i) => i.metadata.slug === c.service
      );

      if (!integration) {
        return [];
      }

      return {
        ...c,
        possibleConnections: allConnections.filter(
          (a) => a.apiIdentifier === c.service
        ),
        integration: integration.metadata,
      };
    }),
  };

  let externalSourceConfig: ExternalSourceConfig | undefined = undefined;

  if (workflow.externalSource && !workflow.externalSource.manualRegistration) {
    externalSourceConfig = {
      type: "integration",
      url: buildExternalSourceUrl(
        workflow.externalSource.id,
        workflow.externalSource.service
      ),
    };
  } else if (
    workflow.externalSource &&
    workflow.externalSource.manualRegistration
  ) {
    const parsedManualWebhook = ManualWebhookSourceSchema.safeParse(
      workflow.externalSource.source
    );
    if (parsedManualWebhook.success) {
      externalSourceConfig = {
        type: "manual",
        data: {
          success: true,
          url: buildExternalSourceUrl(
            workflow.externalSource.id,
            workflow.externalSource.service
          ),
          secret: parsedManualWebhook.data.verifyPayload.enabled
            ? workflow.externalSource.secret ?? undefined
            : undefined,
        },
      };
    } else {
      externalSourceConfig = {
        type: "manual",
        data: {
          success: false,
          error: parsedManualWebhook.error.message,
        },
      };
    }
  }

  return typedjson({
    workflow: {
      ...workflow,
      rules,
      externalSourceConfig,
    },
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
